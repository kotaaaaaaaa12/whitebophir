<script context="module" lang="ts">
	import { writable } from "svelte/store";
	export const progressBarSeek = writable<number>(0);
</script>

<script lang="ts">
	import { t } from "$lib/i18n";
	import { AudioPlayer } from "$lib/player";
	import { format } from "$lib/utils";
	import { createEventDispatcher } from "svelte";

	const { currentTimeStore, durationStore } = AudioPlayer;
	const dispatch = createEventDispatcher<{ seek: number }>();
	let scrubbing = false;
	let preview = 0;
	$: duration = Number.isFinite($durationStore) && $durationStore > 0 ? $durationStore : 0;
	$: position = Math.min(duration, Math.max(0, scrubbing ? preview : $currentTimeStore));

	function previewSeek(event: Event) {
		scrubbing = true;
		preview = Number((event.currentTarget as HTMLInputElement).value);
	}
	function commitSeek(event: Event) {
		const target = Number((event.currentTarget as HTMLInputElement).value);
		AudioPlayer.seek(target);
		progressBarSeek.set(target);
		dispatch("seek", target);
		scrubbing = false;
	}
</script>

<div class="progress-container">
	<span class="timestamp secondary">{format(position)}</span>
	<div class="progress-bar-wrapper">
		<div class="progress-bar">
			<progress value={position} max={duration || 1} aria-hidden="true" />
			<input
				class="seek-control"
				type="range"
				aria-label={$t("Seek playback")}
				aria-valuetext="{format(position)} of {format(duration)}"
				min="0"
				max={duration || 1}
				step="0.1"
				value={position}
				disabled={duration === 0}
				on:input={previewSeek}
				on:change={commitSeek}
				on:click|stopPropagation
				on:pointerdown|stopPropagation
				on:pointercancel={() => (scrubbing = false)}
				on:blur={() => (scrubbing = false)}
			/>
		</div>
	</div>
	<span class="timestamp secondary">{format(duration)}</span>
</div>

<style src="./index.scss" lang="scss"></style>
