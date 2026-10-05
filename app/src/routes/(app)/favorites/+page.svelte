<script lang="ts">
	import { t } from "$lib/i18n";
	import { IDBService } from "$lib/workers/db/service";
	import { onMount } from "svelte";
	import list from "$lib/stores/list";
	import type { Item } from "$lib/types";
    import Button from "$components/Button/Button.svelte";
	import DraggableList from "$components/DraggableList/DraggableList.svelte";
	import ListItem, { listItemPageContext } from "$components/ListItem/ListItem.svelte";
	import { CTX_ListItem } from "$lib/contexts";
	import { isPagePlaying } from "$lib/stores/stores";
	import { getSrc } from "$lib/player";

	let value: number = 0;
	let songs: Item[] = [];

	CTX_ListItem.set({ parentPlaylistId: null, visitorData: "" });
	listItemPageContext.add("library");

	function normalizeItem(song: any): Item {
		return {
			...song,
			explicit: song.explicit === undefined ? false : song.explicit,
			subtitle: song.subtitle || [],
			artistInfo: song.artistInfo || { artist: [] },
			aspectRatio: song.aspectRatio || "1:1",
			videoId: song.videoId || "",
			playlistId: song.playlistId || "favorites",
			thumbnails: song.thumbnails || [],
		} as Item;
	}

	onMount(async () => {
		const result = await IDBService.sendMessage("get", "favorites");
		if (result) {
			songs = result.map(normalizeItem);
		}
	});

	let options = [
		{
			label: "Unsorted",
			params: "nosort",
			action: async () => {
				const result = await IDBService.sendMessage("get", "favorites");
				if (result) {
					songs = result.map(normalizeItem);
				}
			},
		},
		{
			label: "A-Z",
			params: "az",
			action: () => {
				songs = [...songs].sort((a, b) => a.title.localeCompare(b.title)).map(normalizeItem);
			},
		},
		{
			label: "Z-A",
			params: "za",
			action: () => {
				songs = [...songs].sort((a, b) => b.title.localeCompare(a.title)).map(normalizeItem);
			},
		},
	];
</script>

<main>
	<h1>{$t("Your Favorites")}</h1>
	<section>
		<div class="filter">
			<div class="ctx-item">
				<label for="select">{$t("Sort")}</label>
				<div class="select">
					<select
						id="select"
						bind:value
						on:change={options[value].action}
					>
						{#each options as option, i (option.params)}
							<option value={i}>{$t(option.label)}</option>
						{/each}
					</select>
				</div>
			</div>

		</div>
		<section>
			{#if songs && songs.length > 0}
				<DraggableList items={songs}>
					<ListItem
						let:item
						let:index
						{item}
						idx={index}
						slot="item"
						on:initLocalPlaylist={async ({ detail }) => {
							await list.setMix(songs.map(item => ({ ...item, IS_LOCAL: true })), "local");
							await list.updatePosition(detail.idx);
							isPagePlaying.add("favorites");
							await getSrc($list.mix[detail.idx]?.videoId);
						}}
						on:setPageIsPlaying={async ({ detail }) => {
							await list.updatePosition(detail.index);
						}}
					/>
				</DraggableList>
			{:else}
				<div class="empty-state">
					<p>{$t("No favorites yet. Add some songs to your favorites to see them here!")}</p>
				</div>
			{/if}
		</section>
	</section>
</main>

<style lang="scss">
	.filter {
		display: inline-flex;
		flex-direction: row;
		margin-bottom: $md-spacing;
		align-items: center;
		gap: $md-spacing;
	}

	.ctx-item {
		display: flex;

		label {
			margin-right: $md-spacing;
			white-space: pre;
		}
	}

	.empty-state {
		text-align: center;
		padding: $lg-spacing;
		color: var(--text-secondary);
	}
</style>