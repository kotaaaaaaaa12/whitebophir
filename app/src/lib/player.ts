/* eslint-disable @typescript-eslint/no-inferrable-types */
import { browser } from "$app/environment";
import { SessionListService } from "$stores/list/sessionList";
import type { UserSettings } from "$stores/settings";
import Hls, { type HlsConfig } from "hls.js";
import { tick } from "svelte";
import { tweened } from "svelte/motion";
import { writable } from "svelte/store";
import { APIClient } from "./api";
import { sort, type PlayerFormats } from "./parsers/player";
import { settings, type ISessionListProvider } from "./stores";
import { groupSession, type ConnectionState } from "./stores/sessions";
import { syncTabs } from "./tabSync";
import { WritableStore, notify, type ResponseBody } from "./utils";
import { objectKeys } from "./utils/collections/objects";
import { setWorkerInterval } from "./utils/workerTimeout";

let userSettings: UserSettings | undefined = undefined;

export type Callback<K extends keyof HTMLElementEventMap> = (
	this: HTMLElement,
	event: HTMLElementEventMap[K],
) => void;

export type Listeners = Map<string, Callback<keyof HTMLElementEventMap>[]>;

export interface IEventHandler {
	onEvent<K extends keyof HTMLElementEventMap>(type: K, cb: Callback<K>): void;
}

type SrcDict = { original_url: string; url: string; video_url?: string; duration?: number; autoplay?: boolean };

interface AudioPlayerEvents {
	play: unknown;
	"update:stream_type": { type: "HLS" | "HTTP" };
}

// Safari can report unknown duration while suspending or reloading media.
const setPosition = (currentTime: number, duration: number) => {
	if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState ||
		!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;
	try {
		navigator.mediaSession.setPositionState({
			duration,
			position: Math.min(Math.max(currentTime, 0), duration),
		});
	} catch {
		// Lock-screen controls must not interrupt playback if the browser rejects a position.
	}
};

const setMediaAction = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
	try {
		navigator.mediaSession.setActionHandler(action, handler);
	} catch {
		// Some Safari versions do not support every Media Session action.
	}
};

function metaDataHandler({
	currentTime,
	duration,
	sessionList,
}: {
	currentTime: number;
	duration: number;
	sessionList: ISessionListProvider;
}) {
	if ("mediaSession" in navigator) {
		const position = sessionList.position;
		const currentTrack = sessionList.mix[position];

		const artwork = currentTrack?.thumbnails ?? [];

		console.debug({ currentTrack, position, mix: sessionList.mix });

		if (!currentTrack) return console.debug("no current track");
		navigator.mediaSession.metadata = new MediaMetadata({
			title: currentTrack?.title,
			artist: currentTrack?.artistInfo?.artist?.[0]?.text || "",
			album: currentTrack?.album?.title ?? undefined,
			artwork: [...artwork].reverse().map(({ url, width, height }) => ({
				src: url,
				sizes: `${width}x${height}`,
				type: "image/jpeg",
			})),
		});
		setMediaAction("play", () => {
			AudioPlayer.play();
		});
		setMediaAction("pause", () => AudioPlayer.pause());
		setMediaAction("seekto", (session) => {
			if (session.fastSeek && "fastSeek" in AudioPlayer) {
				if (session.seekTime !== undefined) AudioPlayer.fastSeek(session.seekTime);
				setPosition(
					session.seekTime ?? AudioPlayer.currentTime,
					AudioPlayer.duration,
				);
				return;
			}
			if (session.seekTime !== undefined) AudioPlayer.seek(session.seekTime);

			setPosition(
				session.seekTime ?? AudioPlayer.currentTime,
				AudioPlayer.duration,
			);
		});
		setMediaAction("previoustrack", () =>
			SessionListService.previous(),
		);
		setMediaAction("nexttrack", () =>
			SessionListService.next(),
		);
		setPosition(currentTime, duration);
	}
}

export const updateGroupState = (opts: {
	client: string;
	state: ConnectionState;
}): void => groupSession.sendGroupState(opts);

export const updateGroupPosition = (
	dir: "<-" | "->" | undefined,
	position: number,
): void =>
	groupSession.send(
		"PATCH",
		"state.update.position",
		{ dir, position } as never,
		groupSession.client,
	);

// Helper to generate a fallback URL if the current src fails to play
function createFallbackUrl(currentUrl: string) {
	if (typeof currentUrl !== "string")
		throw Error(
			`Expected parameter 'currentUrl' to be a string, received ${currentUrl}`,
		);
	const srcUrl = new URL(currentUrl);

	if (!srcUrl.hostname.includes("googlevideo.com")) return currentUrl;

	// example: [ rr4---sn-p5ql61yl , googlevideo , com ]
	const [subdomain, domain, ext] = srcUrl.hostname.split(".");

	const fvip = srcUrl.searchParams.get("fvip") ?? "";
	// comma-separated list of fallback server hosts
	const mn = srcUrl.searchParams.get("mn") ?? "";

	let [preDashes, postDashes] = subdomain.split("---");
	// step 1: replace digits in first part of subdomain with fvip
	preDashes = preDashes.replace(/\d/g, fvip);

	// step 2: use one of the fallback server names found in mn
	postDashes = mn.split(",")[1];

	/**  */
	srcUrl.hostname = `${`${preDashes}---${postDashes}`}.${domain}.${ext}`;

	return srcUrl.toString();
}

type EventCallbackFn<T> = (data: T) => void;

class EventEmitter<Events> {
	private listeners: Map<
		keyof Events,
		EventCallbackFn<Events[keyof Events]>[]
	> = new Map();

	constructor() {
		//
	}

	dispatch<Key extends keyof Events = keyof Events>(
		name: Key,
		data: Events[Key],
	) {
		const listeners = this.listeners.get(name) ?? [];

		for (const cb of listeners) {
			cb?.(data);
		}
	}

	off<Key extends keyof Events = keyof Events>(
		name: Key,
		callback: EventCallbackFn<Events[Key]>,
	) {
		const listeners = this.listeners.get(name) ?? [];
		const index = listeners.indexOf(callback as never);

		if (index > 0) {
			listeners.splice(index, 1);
		}
		this.listeners.set(name, listeners);
	}

	on<Key extends keyof Events = keyof Events & string>(
		name: Key,
		callback: EventCallbackFn<Events[Key]>,
	) {
		const listeners = this.listeners.get(name) ?? [];
		listeners.push(callback as never);
		this.listeners.set(name, listeners);
	}
}

const loadAndAttachHLS = async () => {
	const hls = await import("hls.js");
	const Hls = hls.default;
	if (Hls.isSupported() === false) return null;
	const hlsjsConfig: Partial<HlsConfig> = {
		lowLatencyMode: true,
		enableWorker: true,
		progressive: true,
		manifestLoadingMaxRetry: 2,
		backBufferLength: 90,
	};
	return new Hls(hlsjsConfig);
};

const loadVideo = (player: HTMLVideoElement) => {
	return new Promise((resolve, reject) => {
		player.onloadeddata = () => {
			resolve(player);
		};
		player.onerror = (e) => {
			reject(e);
		};

		player.load();
	});
};

const getPlayerVolumeFromLS = (player: WritableStore<number>) => {
	const storedLevel = localStorage.getItem("volume");
	const setDefaultVolume = () => {
		localStorage.setItem("volume", "0.5");
		player.set(0.5);
	};

	if (storedLevel !== null) {
		try {
			player.set(+storedLevel);
		} catch {
			setDefaultVolume();
		}
	} else {
		setDefaultVolume();
	}
};
class AudioPlayerImpl extends EventEmitter<AudioPlayerEvents> {
	private _currentTimeStore = new WritableStore<number>(0);
	private _durationStore = new WritableStore<number>(0);
	private _volumeStore = new WritableStore<number>(0);
	private _paused = writable(true);
	private _loading = writable(false);
	private _progress = tweened<number>(0);
	private _mode = new WritableStore<"audio" | "video">("audio");
	private _leechInterval: ReturnType<typeof setWorkerInterval> | null = null;
	private _taskQueue: [
		name: keyof AudioPlayerImpl,
		args: [...rest: unknown[]],
	][] = [];
	private hls: Hls | undefined;
	private _videoUrl = new WritableStore<string | undefined>(undefined);
	private audioNodeListeners: Record<string, () => void> = {};
	private invalidationTimer: ReturnType<typeof setTimeout> | null = null;
	private nextSrc: { stale: boolean; url: string | undefined } = {
		stale: false,
		url: "",
	};
	public async setType(type: "HLS" | "HTTP") {
		if (!this.player) {
			this.createAudioNode();
			window["_player"] = this.player;
		}
		// console.log(type);
		if (type === "HLS") {
			this.playerKind = Hls.isSupported() ? "hls" : "html5";
			if (this.playerKind !== "hls") return;
			if (!this.hls) {
				// console.log("loadHLS");
				await this.loadHLS();
			}
		}
		if (type === "HTTP") {
			this.playerKind = "html5";
			if (this.hls) {
				this.hls.destroy();
			}
		}
	}
	private declare player: HTMLAudioElement;
	private declare videoPlayer: HTMLVideoElement | undefined;
	private _repeat: string = "off";
	private lastPosition = 0;
	private pendingPosition: number | undefined;
	private playRequested = false;
	private sourceRevision = 0;
	private contentDuration: number | undefined;
	private resolvingTrack = false;
	private nextWarmAt = 0;
	private playerKind: "hls" | "html5" = "html5";
	private declare unsubscriber: () => void;
	constructor() {
		super();
		if (browser) {
			const onUserInteractionCallback = () => {
				if (!this.player) {
					this.createAudioNode();
					window["_player"] = this.player;
				}
			};

			document.addEventListener("click", onUserInteractionCallback, {
				capture: true,
				once: true,
			});
		}
	}

	public get currentTimeStore() {
		return this._currentTimeStore;
	}
	public get currentTime() {
		return this._currentTimeStore.value;
	}

	public get mode() {
		return this._mode;
	}

	public get videoUrlStore() {
		return this._videoUrl;
	}

	public get videoNode() {
		return this.videoPlayer;
	}
	public set videoNode(node: HTMLVideoElement | undefined) {
		this.videoPlayer = node;
		if (this.videoPlayer && this._videoUrl.value) {
			this.videoPlayer.src = this._videoUrl.value;
			this.videoPlayer.load();
			this.videoPlayer.currentTime = this.currentTime;
			this.videoPlayer.play();
			this.videoPlayer.currentTime = this.currentTime;
		}
	}

	public repeat(state: "off" | "track" | "playlist") {
		if (state === "track") {
			this.player.loop = true;
		} else this.player.loop = false;

		this._repeat = state;
	}

	public fastSeek(to: number) {
		this.seek(to, true);
	}

	public get durationStore() {
		return this._durationStore;
	}

	public get duration() {
		return this._durationStore.value;
	}
	public get paused() {
		return this._paused;
	}
	public get loading() {
		return this._loading;
	}
	public get playbackRequested() {
		return this.playRequested;
	}
	public prepareTrack() {
		this.resolvingTrack = true;
		this.contentDuration = undefined;
		this.playRequested = true;
		this._paused.set(false);
		this._loading.set(true);
		// Do not offer a seek range from the previous track while resolving this one.
		this._durationStore.set(0);
	}
	public trackLookupFailed() {
		this.resolvingTrack = false;
		this._loading.set(false);
		this.playRequested = !!this.player && !this.player.paused;
		this._paused.set(!this.playRequested);
	}

	public get progress() {
		return this._progress;
	}

	public set progress(value) {
		this._progress = value;
	}

	public get subscribe() {
		return () => {
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			return () => {};
		};
	}

	public get volume() {
		return this._volumeStore;
	}

	public setVolume(value: number) {
		if (!this.player) return;
		this._volumeStore.set(value);
	}

	public dispose() {
		const keys = objectKeys(this.audioNodeListeners);
		for (const key of keys) {
			const callback = this.audioNodeListeners[key];
			this.player.removeEventListener(key, callback);
		}
	}

	public pause() {
		this.playRequested = false;
		this._loading.set(false);
		this._paused.set(true);
		this.capturePosition();
		syncTabs.playback({
			state: "pause",
			currentTime: this.currentTime,
			duration: this.duration,
		});
		if (this._leechInterval) {
			this._leechInterval.clear()?.then(() => {
				this._leechInterval = null;
			});
			return;
		} else {
			if (!this.player) {
				this.addTaskToTaskQueue("pause");
				return;
			}
			this.paused.set(true);
			this.player.pause();
		}
	}

	public play() {
		this.playRequested = true;
		this._paused.set(false);
		if (!this.player) {
			this.addTaskToTaskQueue("play");
			return;
		}
		syncTabs.playback({
			state: "play",
			currentTime: this.currentTime,
			duration: this.duration,
		});
		if (
			groupSession.initialized === true &&
			groupSession.hasActiveSession === true
		) {
			updateGroupState({
				client: groupSession.client.clientId,
				state: {
					finished: this.player.ended,
					paused: false,
					playing: true,
					pos: SessionListService.position,
					stalled: !!this.player.error,
				} as ConnectionState,
			});
		}
		this._loading.set(this.player.readyState < 3 || this.pendingPosition !== undefined);
		if (!this.restorePosition()) return;
		const revision = this.sourceRevision;
		const promise = this.player.play();
		if (promise) {
			promise
				.catch((e) => {
					if (revision !== this.sourceRevision || e.name === "AbortError") return;
					this.playRequested = false;
					this._loading.set(false);
					this._paused.set(this.player.paused);
					console.error("Playback could not resume", e);
				});
		}
	}

	public seek(to: number, fast = false) {
		if (!this.player || !Number.isFinite(to)) return;
		if (to < this.durationStore.value / 2) this.setStaleTimeout();
		const duration = this.contentDuration ?? this.player.duration;
		const position = Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(to, duration) : to);
		// An explicit seek, including seek-to-zero, replaces any recovery checkpoint.
		this.pendingPosition = position;
		this.lastPosition = position;
		if (this.player.readyState >= 1) {
			try {
				if (fast && typeof this.player.fastSeek === "function") this.player.fastSeek(position);
				else this.player.currentTime = position;
				if (Math.abs(this.player.currentTime - position) < 0.5) this.pendingPosition = undefined;
			} catch {
				// Apply this seek after metadata arrives instead of losing the requested position.
			}
		}
		this._currentTimeStore.set(position);
		this._progress.set(position, { duration: 10 });
		setPosition(position, this.duration);
	}

	private capturePosition() {
		if (!this.player || this.pendingPosition !== undefined) return;
		if (this.player.readyState === 0 && this.lastPosition > 0) {
			this.pendingPosition = this.lastPosition;
			return;
		}
		if (Number.isFinite(this.player.currentTime)) {
			this.lastPosition = this.player.currentTime;
			this._currentTimeStore.set(this.lastPosition);
		}
	}

	private restorePosition() {
		if (this.pendingPosition === undefined) return true;
		if (this.player.readyState < 1) return false;
		const duration = this.player.duration;
		const target = Number.isFinite(duration)
			? Math.min(this.pendingPosition, Math.max(0, duration - 0.05))
			: this.pendingPosition;
		try {
			this.player.currentTime = target;
			if (Math.abs(this.player.currentTime - target) > 0.5) return false;
			this.pendingPosition = undefined;
			this.lastPosition = target;
			this._currentTimeStore.set(target);
			return true;
		} catch {
			// Retry when metadata becomes available; keep the checkpoint meanwhile.
			return false;
		}
	}

	public setNextTrackPrefetchedUrl(trackUrl: string) {
		this.nextSrc.url = trackUrl;
		this.nextSrc.stale = false;
	}

	/** Used when sync'ing a 'leech' tab */
	public async fakePlay(currentTime: number, duration: number) {
		if (this._leechInterval) await this._leechInterval.clear();
		this._paused.set(false);
		this._currentTimeStore.set(currentTime);
		this._durationStore.set(duration);

		this._leechInterval = setWorkerInterval(() => {
			this._currentTimeStore.set(this._currentTimeStore.value + 1);
		}, 1000);
	}

	public async updateSrc({
		url,
		videoUrl,
		duration,
		preservePosition = false,
		autoplay = true,
	}: {
		autoplay?: boolean;
		preservePosition?: boolean;
		videoUrl?: string;
		url: string;
		duration?: number;
	}) {
		if (url === undefined) return;
		this.resolvingTrack = false;
		const checkpoint = preservePosition ? this.lastPosition : 0;
		this.sourceRevision++;
		this.nextWarmAt = 0;
		this.lastPosition = checkpoint;
		this.pendingPosition = checkpoint > 0 ? checkpoint : undefined;
		this._currentTimeStore.set(checkpoint);
		this.playRequested = autoplay;
		this._paused.set(!autoplay);
		this._loading.set(autoplay);

		if (videoUrl && this.videoPlayer) {
			this.videoPlayer.src = videoUrl;
		}
		this._videoUrl.set(videoUrl);
		if (this.playerKind === "hls") {
			this.loadHLS(url);
		} else {
			this.player.src = url;
		}

		this.contentDuration = duration !== undefined && Number.isFinite(duration) && duration > 0
			? duration / 1000 : undefined;
		this._durationStore.set(this.contentDuration ?? 0);
		markPlaybackSource(url);
		setPosition(checkpoint, this.duration);

		this.nextSrc.url = undefined;
		this.setStaleTimeout();
		// Request playback as soon as the URL is assigned, without a metadata gate.
		if (autoplay) this.play();
	}

	private addTaskToTaskQueue(name: keyof AudioPlayerImpl, ...args: unknown[]) {
		this._taskQueue.push([name, args]);
	}

	private async loadHLS(source?: string) {
		if (this.hls) this.hls.destroy();
		const hls = await loadAndAttachHLS();
		if (!hls) return;
		this.hls = hls;

		this.hls.attachMedia(this.player);

		this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
			this.hls?.loadSource(source || this.player.src);
		});

		this.hls.on(Hls.Events.ERROR, (_event, data) => {
			const type = data.type;
			switch (type) {
				case Hls.ErrorTypes.MEDIA_ERROR:
					this.hls?.recoverMediaError();
					break;
				case Hls.ErrorTypes.NETWORK_ERROR:
					this.hls?.startLoad();
					break;
				default:
			}
		});
	}
	private errorCount = 0;
	private handleError() {
		if (++this.errorCount > 2) {
			this.errorCount = 0;
			this.updateSrc({
				url: createFallbackUrl(this.player.src),
				preservePosition: true,
			});
		}
	}

	private async handleRepeat() {
		if (
			this._repeat === "playlist" &&
			SessionListService.$.value.position >=
			SessionListService.$.value.mix.length - 1
		) {
			const first = SessionListService.$.value.mix[0];
			await SessionListService.updatePosition(0);
			if (first) await getSrc(first.videoId, first.playlistId, undefined, true);
			return false;
		} else if (this._repeat === "track") {
			return false;
		}
	}

	private createAudioNode() {
		let locked = false;
		this.player = new Audio();
		// Start only for a requested track or resume, never merely because metadata reloaded.
		this.player.autoplay = false;
		this.player.preload = "auto";

		getPlayerVolumeFromLS(this._volumeStore);

		this._mode.subscribe(async (value) => {
			await tick();
			if (value === "audio") {
				if (this.videoPlayer) {
					this.videoPlayer.pause();
					this.videoPlayer.autoplay = false;
				}
			} else {
				if (this.videoPlayer) {
					await tick();
					this.videoPlayer.autoplay = true;
					await this.videoPlayer.play();
					this.videoPlayer.currentTime = this.player.currentTime;
				}
			}
		});
		this._volumeStore.subscribe((value) => {
			this.player.volume = value;
			localStorage.setItem("volume", value.toString());
		});

		// Keep the same audio element and listeners through app switches and BFCache.
		// Mobile Safari may freeze JavaScript while native audio continues playing.
		window.addEventListener("pagehide", () => this.capturePosition());
		document.addEventListener("visibilitychange", () => {
			this.capturePosition();
			setPosition(this.currentTime, this.duration);
		});
		window.addEventListener("pageshow", () => {
			this.restorePosition();
			this.capturePosition();
		});

		this.onEvent("emptied", () => {
			// A same-track media reload can clear currentTime before metadata returns.
			if (this.lastPosition > 0) this.pendingPosition = this.lastPosition;
		});

		this.onEvent("loadedmetadata", () => {
			const revision = this.sourceRevision;
			if (this.pendingPosition === undefined && this.lastPosition > 0 &&
				this.player.currentTime === 0) this.pendingPosition = this.lastPosition;
			this.restorePosition();
			this.capturePosition();
			this.refreshDuration();
			if (this.videoNode) {
				loadVideo(this.videoNode).then(() => {
					if (revision !== this.sourceRevision || !this.videoNode) return;
					this.videoNode.currentTime = this.player.currentTime;
					if (this.playRequested && this._mode.value === "video")
						void this.videoNode.play().catch(console.error);
				}).catch(console.error);
			}
			if (this.playRequested && this.player.paused) this.play();
			groupSession.resetAllCanPlay();
			this.setStaleTimeout();
			this.nextSrc.url = undefined;

			if (syncTabs.role === "host") {
				syncTabs.updatePosition(SessionListService.position);
			}
			metaDataHandler({
				duration: this.duration,
				currentTime: this.currentTime,
				sessionList: SessionListService.$.value,
			});
		});

		this.onEvent("canplay", () => {
			if (this.playRequested && this.player.paused && this.restorePosition()) this.play();
		});
		this.onEvent("durationchange", () => {
			this.restorePosition();
			this.refreshDuration();
		});
		this.onEvent("play", () => {
			if (this.player.paused) return;
			this.playRequested = true;
			this._paused.set(false);
			if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
		});
		this.onEvent("playing", () => {
			this._loading.set(false);
			markPlaybackStarted(this.player.src);
			this.warmNextTrack();
		});
		this.onEvent("waiting", () => this._loading.set(this.playRequested));
		this.onEvent("stalled", () => this._loading.set(this.playRequested));
		this.onEvent("pause", () => {
			// Finishing the previous source can queue pause while the next URL resolves.
			// Explicit pause() already clears the intent, including during that lookup.
			if (this.player.readyState > 0 && !this.resolvingTrack) this.playRequested = false;
			this.capturePosition();
			this._paused.set(!this.playRequested);
			if (!this.playRequested) this._loading.set(false);
			if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
		});

		this.onEvent("seeked", () => {
			this.capturePosition();
			if (this.player.readyState >= 3) this._loading.set(false);
			if (this.videoPlayer && this._mode.value === "video") {
				this.videoPlayer.currentTime = this.player.currentTime;
			}
		});


		// Native completion and the validated content boundary share one transition lock.
		const finishTrack = async () => {
			if (locked || this.resolvingTrack || this.pendingPosition !== undefined) return;
			this.lastPosition = 0;
			locked = true;
			try {
				if (this._repeat === "track") {
					this.seek(0);
					this.play();
					return;
				}
				// Stop a padded stream at its content boundary before resolving the next track.
				this.player.pause();
				if (this._repeat !== "off") {
					const allowContinuation = await this.handleRepeat();
					if (allowContinuation === false) {
						return;
					}
				}

				if (groupSession.initialized) {
					return await Promise.resolve(
						updateGroupState({
							client: groupSession.client.clientId,
							state: {
								finished: true,
								paused: true,
								playing: false,
								pos: SessionListService.position,
								stalled: !!this.player.error,
							} as ConnectionState,
						}),
					).then(() => {
						const [allCanPlay, fn] = groupSession.allCanPlay();
						if (allCanPlay) {
							fn();
							locked = false;
						}
					});
				}
				if (groupSession.hasActiveSession && !groupSession.allCanPlay) return;
				return await SessionListService.next(this.nextSrc.url).finally(() => {
					locked = false; // Unlock this 'if' block when finished
					this.nextSrc.url = undefined; // Set to undefined since e 'used' the value
				});
			} finally {
				locked = false;
				this.nextSrc.url = undefined; // Set to undefined since e 'used' the value
			}
		};
		this.onEvent("ended", () => {
			if (this.player.ended) void finishTrack().catch(console.error);
		});
		this.onEvent("timeupdate", () => {
			if (!this.restorePosition()) return;
			this.capturePosition();
			setPosition(this.currentTime, this.duration);
			if (this.duration > 0 && this.duration - this.currentTime <= 20) this.warmNextTrack();
			if (this.contentDuration !== undefined && this.player.currentTime >= this.contentDuration &&
				!this.player.paused && !this.player.seeking && !this.player.error) {
				void finishTrack().catch(console.error);
			}
		});


		this.onEvent("error", () => {
			if (
				this.player?.error?.message.includes("Empty src") ||
				!this.player?.error?.message
			) return;

			console.error(this.player.error);
			this._loading.set(false);
			this._paused.set(this.player.paused);
			playerLookups.clear();

            handleError(this.player.error.message+" (ensure you have updated cookie/oauth details)");
		});


		this.on("update:stream_type", async ({ type }) => {
			this.setType(type);
		});

		// If there's any actions (eg: set volume) that take place before
		// we're setup, they'll be put in the taskQueue - process them here
		if (this._taskQueue.length) {
			while (this._taskQueue.length) {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const [name, args] = this._taskQueue.shift()!;
				const method = this[name];
				//@ts-expect-error It's fine
				if (typeof method === "function") method.apply(this, args);
			}
		}
	}
	private onEvent(name: keyof HTMLMediaElementEventMap, callback: () => void) {
		if (!this.player) this.createAudioNode();
		this.audioNodeListeners[name] = callback;
		this.player.addEventListener(name, callback);
	}

	private refreshDuration() {
		if (this.resolvingTrack) return;
		if (this.contentDuration !== undefined) {
			this._durationStore.set(this.contentDuration);
		} else if (Number.isFinite(this.player.duration) && this.player.duration > 0) {
			this._durationStore.set(this.player.duration);
		}
	}

	private warmNextTrack() {
		if (Date.now() < this.nextWarmAt) return;
		if (this._repeat === "track") return;
		const state = SessionListService.$.value;
		const next = state.mix[state.position + 1];
		if (!next) {
			if (this._repeat === "playlist") return;
			this.nextWarmAt = Date.now() + 10_000;
			void SessionListService.prefetchNextTrack().catch(() => {});
			return;
		}
		if (!next.videoId || next.localUrl) return;
		this.nextWarmAt = Date.now() + 10_000;
		void resolvePlayer(next.videoId, next.playlistId).catch(() => {});
	}

	private setStaleTimeout() {
		if (this.invalidationTimer) clearTimeout(this.invalidationTimer);

		const remainingTime = this.duration - this.player.currentTime;
		const halfwayTime = this.duration / 2;

		const timeoutDuration = Math.max(halfwayTime - remainingTime / 2, 0);
		this.invalidationTimer = setTimeout(() => {
			this.nextSrc.stale = true;
		}, timeoutDuration);
	}
}

export const AudioPlayer = new AudioPlayerImpl();

// Bound metadata reuse by the signed stream's expiry, so longer tracks can use prefetching.
function metadataExpiry(data: any) {
	const now = Date.now();
	const audio = data.streamingData.adaptiveFormats.find((format: any) => Number(format.itag) === 140);
	try {
		let url = new URL(audio.url, location.href);
		const ticket = url.searchParams.get("ticket");
		if (ticket) {
			const payload = ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
			url = new URL(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
		}
		const expiry = Number(url.searchParams.get("expire")) * 1000;
		if (Number.isFinite(expiry) && expiry > now)
			return Math.min(now + 10 * 60_000, expiry - 30_000);
	} catch {
		// Unknown sources keep the conservative one-minute lifetime.
	}
	return now + 60_000;
}

// Short-lived, bounded metadata cache; concurrent requests share one lookup.
const playerLookups = new Map<string, { expires: number; retries: number; promise: Promise<any> }>();
function resolvePlayer(videoId: string, playlistId?: string, params?: string): Promise<any> {
	const key = JSON.stringify([videoId, playlistId, params]);
	const existing = playerLookups.get(key);
	if (existing && existing.expires > Date.now()) return existing.promise;
	const entry = { expires: Infinity, retries: 0, promise: Promise.resolve<any>(undefined) };
	entry.promise = (async () => {
		for (let attempt = 0; attempt < 30; attempt++) {
			const query = new URLSearchParams({ videoId });
			if (playlistId) query.set("playlistId", playlistId);
			if (params) query.set("playerParams", params);
			const response = await APIClient.fetch(`/api/v1/player.json?${query}`);
			if (response.status === 503 && attempt < 29) {
				entry.retries++;
				await new Promise(resolve => setTimeout(resolve, 1000));
				continue;
			}
			if (!response.ok) throw new Error((await response.text()) || "Unable to start playback. Please try again.");
			const data = await response.json();
			if (!data?.streamingData?.adaptiveFormats?.length || data?.playabilityStatus?.status !== "OK")
				throw new Error(data?.playabilityStatus?.reason || data?.message || "No playable audio was returned.");
			if (data.videoDetails?.videoId && data.videoDetails.videoId !== videoId)
				throw new Error("The audio service returned a different track. Please try again.");
			entry.expires = metadataExpiry(data);

			return data;
		}
	})().catch(error => {
		if (playerLookups.get(key) === entry) playerLookups.delete(key);
		throw error;
	});
	playerLookups.set(key, entry);
	if (playerLookups.size > 8) playerLookups.delete(playerLookups.keys().next().value!);
	return entry.promise;
}
let playbackRequest = 0;

export interface PlaybackTiming {
	version: 1;
	phase: "resolving" | "loading" | "playing" | "failed";
	metadataCache: "miss" | "shared" | "hit";
	metadataMs?: number;
	queueMs?: number;
	sourceReadyMs?: number;
	audioStartMs?: number;
	totalMs?: number;
	readinessRetries: number;
}

export const playbackTiming = writable<PlaybackTiming | null>(null);
export interface PlaybackPreparation {
	request: number;
	videoId: string;
	startedAt: number;
	source: Promise<any>;
}
let activeTiming: {
	request: number;
	startedAt: number;
	sourceAt?: number;
	source?: string;
	result: PlaybackTiming;
} | undefined;
const elapsed = (start: number) => Math.round(performance.now() - start);

/** Start the selected track's lookup while its queue is being fetched. */
export function preparePlayback(videoId: string, playlistId?: string, params?: string): PlaybackPreparation {
	const request = ++playbackRequest;
	const startedAt = performance.now();
	const key = JSON.stringify([videoId, playlistId, params]);
	const cached = playerLookups.get(key);
	const metadataCache = cached && cached.expires > Date.now()
		? cached.expires === Infinity ? "shared" : "hit" : "miss";
	activeTiming = { request, startedAt, result: { version: 1, phase: "resolving", metadataCache, readinessRetries: 0 } };
	playbackTiming.set({ ...activeTiming.result });
	AudioPlayer.prepareTrack();
	const source = resolvePlayer(videoId, playlistId, params).then(data => {
		if (activeTiming?.request === request) {
			activeTiming.result.metadataMs = elapsed(startedAt);
			activeTiming.result.readinessRetries = playerLookups.get(key)?.retries ?? 0;
			playbackTiming.set({ ...activeTiming.result });
		}
		return data;
	});
	// Queue resolution may still be pending when this lookup fails.
	void source.catch(() => {});
	return { request, videoId, startedAt, source };
}

export function isPlaybackPreparationCurrent(prepared: PlaybackPreparation) {
	return prepared.request === playbackRequest;
}

export function recordQueueTiming(prepared: PlaybackPreparation, startedAt: number) {
	if (activeTiming?.request !== prepared.request) return;
	activeTiming.result.queueMs = elapsed(startedAt);
	playbackTiming.set({ ...activeTiming.result });
}

export function cancelPreparedPlayback(prepared: PlaybackPreparation) {
	if (!isPlaybackPreparationCurrent(prepared)) return;
	AudioPlayer.trackLookupFailed();
	if (activeTiming?.request === prepared.request) {
		activeTiming.result.phase = "failed";
		playbackTiming.set({ ...activeTiming.result });
	}
}

function markPlaybackSource(url: string) {
	if (!activeTiming || activeTiming.result.phase !== "resolving") return;
	activeTiming.source = new URL(url, location.href).href;
	activeTiming.sourceAt = performance.now();
	activeTiming.result.sourceReadyMs = elapsed(activeTiming.startedAt);
	activeTiming.result.phase = "loading";
	playbackTiming.set({ ...activeTiming.result });
}

function markPlaybackStarted(url: string) {
	if (!activeTiming || activeTiming.result.phase !== "loading" || activeTiming.source !== url ||
		activeTiming.sourceAt === undefined) return;
	activeTiming.result.audioStartMs = elapsed(activeTiming.sourceAt);
	activeTiming.result.totalMs = elapsed(activeTiming.startedAt);
	activeTiming.result.phase = "playing";
	playbackTiming.set({ ...activeTiming.result });
}

/** Prepare a source without changing playback or displaying an error for optional prefetch. */
export function prefetchSource(videoId: string, playlistId?: string) {
	return resolvePlayer(videoId, playlistId);
}

/** Updates the current track for the audio player */
export function updatePlayerSrc({ url, video_url, duration, autoplay }: SrcDict): void {
	AudioPlayer.updateSrc({ url, videoUrl: video_url, duration, autoplay });
}

// Get source URLs
export const getSrc = async (
	videoId?: string,
	playlistId?: string,
	params?: string,
	shouldAutoplay = true,
	prepared?: PlaybackPreparation,
): Promise<
	| {
		body: ResponseBody | null;
		error: boolean;
	}
	| undefined
> => {
	if (prepared && (prepared.videoId !== videoId || !isPlaybackPreparationCurrent(prepared))) return;
	const preparation = shouldAutoplay ? prepared : undefined;
	let selection = preparation;

	const currentTrack = SessionListService.value.mix.find(t => t.videoId === videoId);
	if (currentTrack?.localUrl) {
		if (shouldAutoplay) {
			++playbackRequest;
			activeTiming = undefined;
			playbackTiming.set(null);
			AudioPlayer.prepareTrack();
		}
		const formats = {
			hls: "",
			dash: "",
			streams: [{ url: currentTrack.localUrl	, original_url: currentTrack.localUrl, mimeType: "audio/mp4" }],
			video: "",
			duration: -1
		}
		return setTrack(formats, shouldAutoplay, AudioPlayer.playbackRequested);
	}
	if (shouldAutoplay && !selection) selection = preparePlayback(videoId || "", playlistId, params);
	const request = selection?.request;

	let res: any;
	try {
		res = selection ? await selection.source : await resolvePlayer(videoId || "", playlistId, params);
	} catch (error) {
		if (request !== undefined && request !== playbackRequest) return;
		if (selection) cancelPreparedPlayback(selection);
		return handleError(error instanceof Error ? error.message : "Unable to start playback.");
	}
	// A slow lookup for an earlier selection must not replace a more recent track.
	if (request !== undefined && request !== playbackRequest) return;

	const formats = sort({
		data: res,
		dash: false,
	});

	const src = setTrack(formats, shouldAutoplay, AudioPlayer.playbackRequested);
	if (src.error && selection) cancelPreparedPlayback(selection);
	return src;
}

function setTrack(formats: PlayerFormats, shouldAutoplay: boolean, autoplay = true) {
	let format = undefined;
	if (userSettings?.playback?.Stream === "HLS") {
		format = { original_url: formats?.hls || "", url: formats.hls || "" };
	} else {
		format = formats.streams?.[0];
	}
	if (format && shouldAutoplay)
		updatePlayerSrc({
			video_url: formats.video,
			original_url: format.original_url,
			url: format.url,
			duration: formats.duration,
			autoplay
		});
	if (!format && shouldAutoplay) {
		AudioPlayer.trackLookupFailed();
		return handleError("No supported audio format was returned for this track.");
	}
	return {
		body: format
			? { original_url: format.original_url, url: format.url }
			: null,
		error: false,
	};
}

function handleError(message: string) {
	console.log("error");

	notify(
		message || "An error occurred while initiating playback, skipping...",
		"error",
		"getNextTrack",
	);
	return {
		body: null,
		error: true,
	};
}

if (browser && globalThis.self.name !== "IDB" && settings) {
	settings.subscribe((value) => {
		userSettings = value;
		if (userSettings?.playback?.Stream) {
			AudioPlayer.setType(userSettings.playback.Stream);
		}
	});
}
