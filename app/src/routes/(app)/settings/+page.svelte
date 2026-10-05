<script
	context="module"
	lang="ts"
>
</script>

<script lang="ts">
	import { t, languagePreference, setLanguage, type LanguagePreference, errorMessage } from "$lib/i18n";
	import { browser } from "$app/environment";
	import Header from "$components/Layouts/Header.svelte";
	import { APIClient } from "$lib/api";
	import { AudioPlayer, playbackTiming } from "$lib/player";
	import { settings, type Theme } from "$stores/settings";
	function changeLanguage(event: Event) {
		setLanguage((event.currentTarget as HTMLSelectElement).value as LanguagePreference);
	}
	const themes: Theme[] = ["Dark", "Dim", "Midnight", "YTM"];
	let diagnosticsMessage = "";
	const milliseconds = (value: number | undefined) => value === undefined ? "Pending" : `${value} ms`;
	async function copyPlaybackDiagnostics() {
		if (!$playbackTiming) return;
		try {
			await navigator.clipboard.writeText(JSON.stringify($playbackTiming, null, 2));
			diagnosticsMessage = "Playback diagnostics copied.";
		} catch {
			diagnosticsMessage = "Copy is unavailable. Select the report below to copy it.";
		}
	}

	function handleStreamSelect() {
		AudioPlayer.dispatch("update:stream_type", {
			type: $settings.playback.Stream ?? "HTTP",
		});
	}

	const updatePrefsCookie = async () => {
		await fetch("/settings/update.json", {
			body: JSON.stringify({
				"Proxy Thumbnails": $settings.network["Proxy Thumbnails"],
				Restricted: $settings.search.Restricted,
			}),
			method: "POST",
		});
	};

	import { onMount } from "svelte";
	onMount(async () => {
		if (browser) {
			const res = await APIClient.fetch("/api/v1/settings");
			if (res.ok) {
				const data = await res.json();
				const input = document.getElementById(
					"downloadPath",
				) as HTMLInputElement;
				if (input && data.downloadPath) {
					input.value = data.downloadPath;
				}
				const ongoingInput = document.getElementById(
					"ongoing-listening",
				) as HTMLInputElement;
				if (ongoingInput && data.ongoingListeningEnabled) {
					ongoingInput.checked = data.ongoingListeningEnabled === "true";
				}
			}
		}
	});
</script>

<Header
	title={$t("Settings")}
	url="/settings"
	desc={$t("Configure your app settings")}
/>
{#if browser}
	<main class="resp-content-width">
        <section>
            <span class="h5">{$t("Language")}</span>
            <div class="setting">
                <label for="language">{$t("Language")}<span>{$t("Follow your browser language. Japanese is used for Japanese browsers; English for all others.")}</span></label>
                <div class="select">
                    <select id="language" name="language" value={$languagePreference} on:change={changeLanguage}>
                        <option value="auto">{$t("Auto")}</option>
                        <option value="ja" lang="ja">日本語</option>
                        <option value="en" lang="en">English</option>
                    </select>
                </div>
            </div>
        </section>
		<section class="playback-diagnostics">
			<details>
				<summary>{$t("Playback diagnostics")}</summary>
				{#if $playbackTiming}
					<dl>
						<dt>{$t("Status")}</dt><dd>{$t($playbackTiming.phase)}</dd>
						<dt>{$t("Playback URL")}</dt><dd>{$t(milliseconds($playbackTiming.metadataMs))}</dd>
						<dt>{$t("Queue")}</dt><dd>{$playbackTiming.queueMs === undefined ? $t("Not requested") : $t(milliseconds($playbackTiming.queueMs))}</dd>
						<dt>{$t("Audio start")}</dt><dd>{$t(milliseconds($playbackTiming.audioStartMs))}</dd>
						<dt>{$t("Total")}</dt><dd>{$t(milliseconds($playbackTiming.totalMs))}</dd>
					</dl>
					<p>{$t("Queue and URL requests may overlap. Audio start measures the time from assigning the URL to playback beginning.")}</p>
					<button class="link" on:click={copyPlaybackDiagnostics}>{$t("Copy playback diagnostics")}</button>
					<p role="status">{$t(diagnosticsMessage)}</p>
					<pre>{JSON.stringify($playbackTiming, null, 2)}</pre>
				{:else}
					<p>{$t("Play a track to record startup timings.")}</p>
				{/if}
			</details>
		</section>
		<section>
			<span class="h5">{$t("Appearance")}</span>
			<div class="setting">
				<label for="theme">{$t("Theme")} </label>
				<div class="select">
					<select
						name="theme"
						id="theme"
						bind:value={$settings["appearance"]["Theme"]}
					>
						{#each themes as theme}
							<option
								value={theme}
								selected={$settings["appearance"]["Theme"] === theme}
								>{$t(theme)}</option
							>
						{/each}
					</select>
				</div>
			</div>
			<div class="setting">
				<label>{$t("Immersive Queue")}</label>
				<input
					type="checkbox"
					name="immersive-queue"
					id="immersive-queue"
					bind:checked={$settings["appearance"]["Immersive Queue"]}
				/>
				<label
					for="immersive-queue"
					class="switch"
				/>
			</div>
		</section>
		<section>
			<span class="h5">{$t("Playback")}</span>
			<div class="setting">
				<label>{$t("Dedupe Automix")}</label>

				<input
					name="dedupe"
					id="dedupe"
					type="checkbox"
					bind:value={$settings["playback"]["Dedupe Automix"]}
				/>
				<label
					for="dedupe"
					class="switch"
				/>
			</div>
			<!-- <div class="setting">
                <label for="quality">Quality</label>
                <div class="select">
                    <select
                        name="quality"
                        disabled
                        id="quality"
                        bind:value={$settings["playback"]["Quality"]}
                    >
                        {#each ["Normal", "High"] as option}
                            <option
                                value={option}
                                selected={$settings["playback"]["Quality"] === option}
                            >{option}</option
                            >
                        {/each}
                    </select>
                </div>
            </div>-->

			<!-- <div class="setting">
                <label>Remember Last Track</label>
                <input
                    name="lasttrack"
                    id="lasttrack"
                    type="checkbox"
                    bind:checked={$settings["playback"]["Remember Last Track"]}
                />
                <label
                    for="lasttrack"
                    class="switch"
                />
            </div>-->
			<!-- <div class="setting">
                <label for="stream">Stream </label>
                <div class="select">
                    <select
                        name="stream"
                        id="stream"
                        bind:value={$settings["playback"]["Stream"]}
                        on:change={handleStreamSelect}
                    >
                        {#each ["HTTP", "HLS"] as option}
                            <option
                                value={option}
                                selected={$settings["playback"]["Stream"] === option}
                            >{option}</option
                            >
                        {/each}
                    </select>
                </div>
            </div>-->
			
			<div class="setting">
				<label for="downloadPath">
					{$t("Download Path")}
					<span class=""> {$t("Folder where playlists will be downloaded.")} </span>
				</label>
				<div class="input-container">
					<div class="input no-btn mb-1">
						<input
							type="text"
							id="downloadPath"
							placeholder="downloads"
							on:change={async (e) => {
								const value = e.currentTarget.value;
								const res = await APIClient.post("/api/v1/settings", {
									downloadPath: value,
								});
								if (!res.ok) {
									const data = await res.json();
									alert(errorMessage(data.error || "Failed to update download path"));
								}
							}}
						/>
					</div>
				</div>
			</div>
			<div class="setting">
				<label
					>{$t("Ongoing Listening Download")}
					<span class="">{$t("Automatically download songs you listen to.")}</span>
				</label>
				<input
					type="checkbox"
					id="ongoing-listening"
					on:change={async (e) => {
						const checked = e.currentTarget.checked;
						const res = await APIClient.post("/api/v1/settings", {
							ongoingListeningEnabled: checked ? "true" : "false",
						});
						if (!res.ok) {
							const data = await res.json();
							alert(errorMessage(data.error || "Failed to update setting"));
							e.currentTarget.checked = !checked; // Revert
						}
					}}
				/>
				<label
					for="ongoing-listening"
					class="switch"
				/>
			</div>
			<div class="setting">
				<!-- svelte-ignore a11y-label-has-associated-control -->
				<label
					>{$t("Playback Updates URL")}
					<span class=""
						>{$t("Playing a song updates the URL with the song's sharing URL.")}</span
					>
				</label>
				<input
					name="update-url"
					id="update-url"
					type="checkbox"
					bind:checked={$settings["playback"]["Playback Updates URL"]}
				/>
				<label
					for="update-url"
					class="switch"
				/>
			</div>
		</section>
		<!--<section>
            <span class="h5">Network</span>
            <div class="setting">
                <label for="proxy"
                >Audio Proxy Server
                    <span class=""
                    >In order to use HLS streaming, a proxy server must be used. <br
                    />Provide the URL to your own, or you can use the default.</span
                    >
                </label>
                <div class="input-container">
                    <div class="input no-btn mb-1">
                        <input
                            type="url"
                            on:blur={(e) => {
								let value = e.currentTarget.value;

								if (!value.endsWith("/")) value = value + "/";

								if (value.match(/^https?:\/\//i)) {
									$settings["network"]["Stream Proxy Server"] = value;
								} else if (value.match(/^(.[0-9]*\.?){1,4}:[0-9]+/im)) {
									$settings["network"]["Stream Proxy Server"] = value;
								}
							}}
                            on:input={(e) => {
								let value = e.currentTarget.value;

								if (value.match(/^https?:\/\//i)) {
									$settings["network"]["Stream Proxy Server"] = value;
								} else if (value.match(/^(.[0-9]*\.?){1,4}:[0-9]+/im)) {
									$settings["network"]["Stream Proxy Server"] = value;
								}
							}}
                            placeholder="https://hls.beatbump.io/"
                            value={$settings["network"]["Stream Proxy Server"]}
                        />
                    </div>
                    <button
                        class="link mt-2"
                        on:click={() => {
							$settings["network"]["Stream Proxy Server"] =
								"https://hls.beatbump.io/";
						}}>Reset to default</button
                    >
                </div>
            </div>
            <div class="setting">
                <label
                >Proxy Audio
                    <span class="">Proxy audio streams through a server.</span>
                </label>
                <input
                    name="proxy-audio"
                    id="proxy-audio"
                    type="checkbox"
                    bind:checked={$settings["network"]["Proxy Streams"]}
                />
                <label
                    for="proxy-audio"
                    class="switch"
                />
            </div>
        </section>-->
		<section>
			<!-- <span class="h5">Search</span>
            <div class="setting">
                <label for="preserve">Preserve </label>
                <div class="select">
                    <select
                        name="preserve"
                        id="preserve"
                        bind:value={$settings["search"]["Preserve"]}
                    >
                        {#each ["Category", "Query", "Category + Query", "None"] as option}
                            <option
                                value={option}
                                selected={$settings["playback"]["Stream"] === option}
                            >{option}</option
                            >
                        {/each}
                    </select>
                </div>
            </div>-->
			<!-- <div class="setting">
                <label for="restricted"
                >Restricted Mode <span
                >Can help reduce the amount of explicit or potentially mature
						content shown. <br />(filter is not 100% accurate)</span
                ></label
                >

                <input
                    name="restricted"
                    id="restricted"
                    on:input={updatePrefsCookie}
                    type="checkbox"
                    bind:checked={$settings["search"]["Restricted"]}
                />
                <label
                    for="restricted"
                    class="switch"
                />
            </div>-->
		</section>
	</main>
{/if}

<style lang="scss">
	.playback-diagnostics {
		summary { cursor: pointer; font-weight: 600; }
		dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem 1rem; }
		dd { margin: 0; font-variant-numeric: tabular-nums; }
		p { line-height: 1.5; }
		pre { max-width: 100%; overflow-x: auto; user-select: text; font-size: 0.8rem; }
	}
	.input-container {
		min-width: 15ch !important;
		max-width: 32ch !important;
		width: 100%;
	}
	button {
		background: unset;
		all: unset;
		margin-top: 0.5rem;
		$link-color: rgb(245, 245, 245);
		color: rgb(245, 245, 245) !important;

		text-decoration: none;
		transition: color 0.2s;
		display: block;
		&.link {
			font-weight: 500;
		}
		&:active,
		&:focus,
		&:hover {
			background: transparent !important;
			-webkit-text-decoration: underline 0.001em solid;
			text-decoration: underline 0.001em solid;
			text-underline-offset: 0.001em;
			color: darken($link-color, 15%);
			outline: none;
		}
		&:hover {
			cursor: pointer;
		}
	}
	label {
		display: inline-flex;
		flex-direction: column;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
			Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
			sans-serif;
		font-size: 1em;
		text-transform: none !important;
		font-variant: unset;
		gap: 0.125em;
		line-height: 1.4;
		:last-child {
			font-size: 0.875em;
			color: hsla(0, 0%, 100%, 0.7);
			line-height: 1.1;
		}

		@media screen and (min-width: 40em) {
			~ :last-child {
				margin-left: auto;
			}
		}
	}

	section {
		display: flex;
		flex-direction: column;
		margin-block-end: 1em;

		&:not(:last-child) {
			border-bottom: 0.01em solid rgb(218 218 218 / 8.2%);
		}
	}

	.setting {
		display: inline-flex;
		color: inherit;
		vertical-align: top;
		gap: 1em;
		flex-direction: column;
		margin-block: 1em;

		&:first-of-type {
			margin-block-start: 0;
		}

		&:last-of-type {
			margin-block-end: 2em;
		}

		@media screen and (min-width: 40em) {
			align-items: center;
			flex-direction: row;
		}
	}

	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		width: 3.8125em;
		height: 2em;
		cursor: pointer;
		overflow: hidden;
		background-color: rgb(109 109 109 / 35%);
		border-radius: 1.25rem;
		transition: background-color 0.3s;
	}

	.switch::after {
		--size: calc(2rem - (2px * 2));

		content: "";
		position: absolute;
		width: var(--size);
		height: var(--size);
		border-radius: 9999em;
		background-color: white;
		top: 50%;
		transform: translateY(-50%);
		left: 0.125em;
		transition: left 0.3s;
		box-shadow: 0 0 12px -3px rgb(0 0 0 / 38.4%);
	}

	[type="checkbox"]:checked + .switch::after {
		left: 2em;
	}

	[type="checkbox"]:checked + .switch {
		background-color: #00cd6a;
	}

	[type="checkbox"] {
		display: none;
	}
</style>
