<svelte:options immutable={true} />

<script lang="ts">
	import { t } from "$lib/i18n";
	import { AudioPlayer } from "$lib/player";
	import { playerLoading } from "$lib/stores";
	import { queue } from "$lib/stores/list";
	import Icon from "../Icon/Icon.svelte";
	const { paused, loading: audioLoading } = AudioPlayer;

	$: isPaused = $paused;
	$: console.log(isPaused);
	function handleButtonPress() {
		if (!$queue) return;
		if (isPaused) {
			// console.log(e)
			// AudioPlayer.play(e)
			return AudioPlayer.play();
		} else {
			AudioPlayer.pause();
		}
	}
</script>

<button
	type="button"
	class="player-btn player-title"
	aria-label={$t($playerLoading || $audioLoading ? "Cancel loading" : isPaused ? "Play" : "Pause")}
	aria-busy={$playerLoading || $audioLoading}
	on:click|capture|stopPropagation={handleButtonPress}
>
	{#if $playerLoading || $audioLoading}
		<div
			class="player-spinner"
			class:fade-out={true}
		/>
	{:else if isPaused}
		<Icon
			color="white"
			name="play"
			size={"24px"}
		/>
	{:else}
		<Icon
			color="white"
			name="pause"
			size={"1.625rem"}
		/>
	{/if}
</button>

<style lang="scss">
	@import "../../../global/stylesheet/components/_player.scss";
	button {
		background: transparent;
		border: 0;
		color: inherit;
		padding: 0;
	}
	.player-spinner {
		width: 1.5rem;
		height: 1.5rem;
		border: 3px solid rgb(255 255 255 / 26%);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
