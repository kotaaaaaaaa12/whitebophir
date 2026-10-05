<script lang="ts">
	import { t } from "$lib/i18n";
	export let value: number;
	export let options: { params: string; action: () => void; label: string }[] =
		[];
</script>

<label
	class="secondary"
	for="select">{$t("Sort")}</label
>

<div class="select">
	<select
		id="select"
		bind:value
		on:change
	>
		{#each options as option, i (option.params)}
			<option
				value={i}
				selected={value === i}>{$t(option.label)}</option
			>
		{/each}
	</select>
</div>

<style
	src="./index.scss"
	lang="scss"
>
</style>
