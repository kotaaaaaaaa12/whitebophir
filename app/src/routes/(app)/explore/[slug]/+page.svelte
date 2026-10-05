<script lang="ts">
	import { t, sectionHeading } from "$lib/i18n";
	import CarouselItem from "$components/Carousel/CarouselItem.svelte";
	import Carousel from "$lib/components/Carousel/Carousel.svelte";
	import { Grid } from "$lib/components/Grid";
	import Header from "$lib/components/Layouts/Header.svelte";

	export let data;
</script>

<Header
	title={$t("{category} Playlists", { category: $sectionHeading(data.response.header) })}
	url={data.path}
	desc={$t("Find the perfect playlist that'll match your mood, or fit any occasion.")}
/>
<main>
	<div class="header">
		<h1>{$sectionHeading(data.response.header)}</h1>
	</div>
	{#each data.response.carousels as item}
			<!-- {@debug section} -->
			<Carousel
				header={item.header}
				items={item.items}
				type="home"
				isBrowseEndpoint={false}
			/>
	{/each}
    <!--{#each data.response.grids as item}
            <Grid
                heading={item.header.title}
                items={item.items}
                let:item
                let:index
            >
                <CarouselItem
                    {index}
                    aspectRatio={item.aspectRatio}
                    {item}
                    kind="isPlaylist"
                    type="home"
                    isBrowseEndpoint={true}
                    slot="item"
                />
            </Grid>
    {/each}-->
</main>

<style lang="scss">
</style>
