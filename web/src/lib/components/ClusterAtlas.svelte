<script lang="ts">
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import { toastStore } from '$lib/client/toast.svelte';
	import type {
		ClusterProjectionCentroid,
		ClusterProjectionData,
		ClusterProjectionPoint
	} from '$lib/cluster-projection-types';

	type ViewMode = '2d' | '3d';
	type HoveredMarker =
		| {
				kind: 'point';
				point: ClusterProjectionPoint;
				x: number;
				y: number;
		  }
		| {
				kind: 'centroid';
				centroid: ClusterProjectionCentroid;
				x: number;
				y: number;
		  };

	let projection = $state<ClusterProjectionData | null>(null);
	let selectedCluster = $state<number | 'all'>('all');
	let mode = $state<ViewMode>('3d');
	let loading = $state(true);
	let error = $state('');
	let playing = $state(false);
	let showCentroids = $state(true);
	let selectedPoint = $state<ClusterProjectionPoint | null>(null);
	let hoveredMarker = $state<HoveredMarker | null>(null);

	let canvas = $state<HTMLCanvasElement>();
	let container = $state<HTMLDivElement>();
	let width = $state(0);
	let height = $state(0);
	let yaw = $state(-0.62);
	let pitch = $state(0.48);
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let dragging = $state(false);
	let dragMoved = $state(false);
	let lastPointerX = 0;
	let lastPointerY = 0;

	const visiblePoints = $derived(
		projection?.points.filter(
			(point) => selectedCluster === 'all' || point.clusterId === selectedCluster
		) ?? []
	);
	const visibleCentroids = $derived(
		showCentroids
			? (projection?.centroids ?? []).filter(
					(centroid) => selectedCluster === 'all' || centroid.clusterId === selectedCluster
				)
			: []
	);
	const hoveredMarkerKey = $derived(
		hoveredMarker?.kind === 'point'
			? `point:${hoveredMarker.point.uri}`
			: hoveredMarker?.kind === 'centroid'
				? `centroid:${hoveredMarker.centroid.clusterId}`
				: ''
	);

	function clusterColor(clusterId: number): string {
		const hue = (clusterId * 137.508 + 18) % 360;
		return `hsl(${hue} 68% 55%)`;
	}

	function clusterName(clusterId: number): string {
		return (
			projection?.clusters.find((cluster) => cluster.id === clusterId)?.name ??
			`Cluster ${clusterId}`
		);
	}

	function resetView() {
		yaw = -0.62;
		pitch = 0.48;
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function setMode(next: ViewMode) {
		mode = next;
		resetView();
	}

	function transformPoint(point: { x: number; y: number; z: number }): {
		x: number;
		y: number;
		depth: number;
	} {
		const scale = Math.min(width, height) * 0.38 * zoom;
		const centerX = width / 2 + panX;
		const centerY = height / 2 + panY;

		if (mode === '2d') {
			return { x: centerX + point.x * scale, y: centerY - point.y * scale, depth: point.z };
		}

		const cosYaw = Math.cos(yaw);
		const sinYaw = Math.sin(yaw);
		const cosPitch = Math.cos(pitch);
		const sinPitch = Math.sin(pitch);
		const x1 = point.x * cosYaw - point.z * sinYaw;
		const z1 = point.x * sinYaw + point.z * cosYaw;
		const y2 = point.y * cosPitch - z1 * sinPitch;
		const depth = point.y * sinPitch + z1 * cosPitch;
		return { x: centerX + x1 * scale, y: centerY - y2 * scale, depth };
	}

	function drawGrid(context: CanvasRenderingContext2D) {
		context.save();
		context.lineWidth = 1;
		for (const value of [-1, 0, 1]) {
			context.strokeStyle = value === 0 ? 'rgba(23,23,23,0.22)' : 'rgba(23,23,23,0.08)';
			context.beginPath();
			const first = transformPoint({ x: value, y: -1, z: -1 });
			const last = transformPoint({ x: value, y: 1, z: 1 });
			context.moveTo(first.x, first.y);
			context.lineTo(last.x, last.y);
			context.stroke();

			context.beginPath();
			const horizontalStart = transformPoint({ x: -1, y: value, z: -1 });
			const horizontalEnd = transformPoint({ x: 1, y: value, z: 1 });
			context.moveTo(horizontalStart.x, horizontalStart.y);
			context.lineTo(horizontalEnd.x, horizontalEnd.y);
			context.stroke();
		}
		context.restore();
	}

	function draw() {
		if (!canvas || width <= 0 || height <= 0) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const targetWidth = Math.round(width * dpr);
		const targetHeight = Math.round(height * dpr);
		if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
			canvas.width = targetWidth;
			canvas.height = targetHeight;
		}
		const context = canvas.getContext('2d');
		if (!context) return;

		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, width, height);
		drawGrid(context);

		const rendered = [
			...visiblePoints.map((point) => ({
				kind: 'point' as const,
				point,
				...transformPoint(point)
			})),
			...visibleCentroids.map((centroid) => ({
				kind: 'centroid' as const,
				centroid,
				...transformPoint(centroid)
			}))
		].sort((a, b) => a.depth - b.depth);

		for (const item of rendered) {
			const depthAlpha =
				mode === '3d' ? Math.max(0.35, Math.min(1, 0.35 + ((item.depth + 1) / 2) * 0.6)) : 0.9;
			if (item.kind === 'point') {
				const isSelected = selectedPoint?.uri === item.point.uri;
				const isHovered =
					hoveredMarker?.kind === 'point' && hoveredMarker.point.uri === item.point.uri;
				context.beginPath();
				context.fillStyle = clusterColor(item.point.clusterId);
				context.globalAlpha = isSelected || isHovered ? 1 : depthAlpha;
				context.arc(
					item.x,
					item.y,
					isSelected || isHovered ? 5 : selectedCluster === 'all' ? 2.4 : 3.2,
					0,
					Math.PI * 2
				);
				context.fill();
				if (isSelected || isHovered) {
					context.globalAlpha = 1;
					context.strokeStyle = '#171717';
					context.lineWidth = 1.5;
					context.stroke();
				}
			} else {
				const isSelected = selectedCluster === item.centroid.clusterId;
				const isHovered =
					hoveredMarker?.kind === 'centroid' &&
					hoveredMarker.centroid.clusterId === item.centroid.clusterId;
				const size = isSelected || isHovered ? 6.5 : selectedCluster === 'all' ? 4.5 : 6;
				context.save();
				context.translate(item.x, item.y);
				context.rotate(Math.PI / 4);
				context.globalAlpha = isSelected || isHovered ? 1 : Math.max(0.72, depthAlpha);
				context.fillStyle = '#f8f4e8';
				context.strokeStyle = clusterColor(item.centroid.clusterId);
				context.lineWidth = 2.2;
				context.fillRect(-size, -size, size * 2, size * 2);
				context.strokeRect(-size, -size, size * 2, size * 2);
				context.restore();
				if (isSelected || isHovered) {
					context.beginPath();
					context.globalAlpha = 1;
					context.arc(item.x, item.y, size + 5, 0, Math.PI * 2);
					context.strokeStyle = '#171717';
					context.lineWidth = 1.2;
					context.stroke();
				}
			}
		}
		context.globalAlpha = 1;
	}

	function markerAt(clientX: number, clientY: number): HoveredMarker | null {
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;

		for (const centroid of visibleCentroids) {
			const projected = transformPoint(centroid);
			if (Math.hypot(projected.x - x, projected.y - y) <= 14) {
				return { kind: 'centroid', centroid, x, y };
			}
		}

		let nearest: HoveredMarker | null = null;
		let nearestDistance = 11;
		for (const point of visiblePoints) {
			const projected = transformPoint(point);
			const distance = Math.hypot(projected.x - x, projected.y - y);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = { kind: 'point', point, x, y };
			}
		}
		return nearest;
	}

	function onPointerDown(event: PointerEvent) {
		if (!canvas) return;
		canvas.setPointerCapture(event.pointerId);
		dragging = true;
		dragMoved = false;
		lastPointerX = event.clientX;
		lastPointerY = event.clientY;
	}

	function onPointerMove(event: PointerEvent) {
		if (dragging) {
			const dx = event.clientX - lastPointerX;
			const dy = event.clientY - lastPointerY;
			if (Math.abs(dx) + Math.abs(dy) > 1) dragMoved = true;
			if (mode === '3d' && !event.shiftKey) {
				yaw += dx * 0.008;
				pitch = Math.max(-1.45, Math.min(1.45, pitch + dy * 0.008));
			} else {
				panX += dx;
				panY += dy;
			}
			lastPointerX = event.clientX;
			lastPointerY = event.clientY;
		} else {
			hoveredMarker = markerAt(event.clientX, event.clientY);
		}
	}

	function onPointerUp(event: PointerEvent) {
		if (!dragMoved) {
			const target = markerAt(event.clientX, event.clientY);
			if (target?.kind === 'centroid') {
				selectedCluster = target.centroid.clusterId;
				selectedPoint = null;
			} else {
				selectedPoint = target?.kind === 'point' ? target.point : null;
			}
		}
		dragging = false;
		if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	}

	function onPointerLeave() {
		if (!dragging) hoveredMarker = null;
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		zoom = Math.max(0.35, Math.min(5, zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.key === '+' || event.key === '=') zoom = Math.min(5, zoom * 1.15);
		else if (event.key === '-') zoom = Math.max(0.35, zoom / 1.15);
		else if (event.key.toLowerCase() === 'r') resetView();
		else if (event.key === '2') setMode('2d');
		else if (event.key === '3') setMode('3d');
		else return;
		event.preventDefault();
	}

	async function playSelected() {
		if (!selectedPoint) return;
		playing = true;
		const { ok } = await post('/api/player', { uris: [selectedPoint.uri] });
		playing = false;
		if (ok) toastStore.show(`Playing ${selectedPoint.name}`);
	}

	$effect(() => {
		// Track every input the canvas depends on so any change redraws.
		void projection;
		void selectedCluster;
		void mode;
		void width;
		void height;
		void yaw;
		void pitch;
		void zoom;
		void panX;
		void panY;
		void showCentroids;
		void hoveredMarkerKey;
		void selectedPoint?.uri;
		draw();
	});

	$effect(() => {
		if (selectedPoint && selectedCluster !== 'all' && selectedPoint.clusterId !== selectedCluster) {
			selectedPoint = null;
		}
	});

	$effect(() => {
		const element = container;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			width = entry.contentRect.width;
			height = entry.contentRect.height;
		});
		observer.observe(element);
		return () => observer.disconnect();
	});

	onMount(() => {
		void api<ClusterProjectionData & { error?: string }>('/api/cluster-visualization').then(
			({ ok, data }) => {
				if (ok) projection = data;
				else error = data?.error ?? 'Could not build the cluster atlas.';
				loading = false;
			}
		);
	});
</script>

<section class="border-ink/15 bg-cream overflow-hidden rounded-3xl border shadow-sm">
	<div class="border-ink/10 border-b p-6 sm:p-7">
		<div class="flex flex-wrap items-start justify-between gap-4">
			<div>
				<p class="text-accent-deep text-[11px] font-bold tracking-[0.24em] uppercase">
					Interactive cluster atlas
				</p>
				<h2 class="font-display mt-1 text-3xl font-black">See the shape of your library</h2>
				<p class="text-ink-soft mt-2 max-w-2xl text-sm leading-relaxed">
					A deterministic PCA sample of every cluster with its full-library centroid. Drag to rotate
					in 3D, pan in 2D, scroll to zoom, and select a point to inspect the track.
				</p>
			</div>
			{#if projection}
				<div class="text-faded text-right text-xs">
					<p>
						<strong class="text-ink">{projection.pointCount.toLocaleString()}</strong> sampled
						points ·
						<strong class="text-ink">{projection.centroids.length}</strong> centroids
					</p>
					<p>{projection.clusters.length} clusters · {projection.dimensions}D source</p>
					{#if projection.activeRun}
						<p class="text-accent-deep mt-1 font-bold">
							Applied run #{projection.activeRun.id} · k={projection.activeRun.k} · {projection.activeRun.trackCount.toLocaleString()}
							tracks
						</p>
					{/if}
				</div>
			{/if}
		</div>

		<div class="mt-5 flex flex-wrap items-center gap-2">
			<div class="bg-ink/5 inline-flex rounded-full p-1">
				<button
					class="rounded-full px-4 py-2 text-sm font-bold transition {mode === '2d'
						? 'bg-ink text-cream shadow'
						: 'text-ink-soft hover:text-ink'}"
					onclick={() => setMode('2d')}>2D plane</button
				>
				<button
					class="rounded-full px-4 py-2 text-sm font-bold transition {mode === '3d'
						? 'bg-ink text-cream shadow'
						: 'text-ink-soft hover:text-ink'}"
					onclick={() => setMode('3d')}>3D cloud</button
				>
			</div>

			<button
				class="rounded-full border px-4 py-2.5 text-sm font-bold transition {showCentroids
					? 'border-accent/30 bg-accent/10 text-accent-deep'
					: 'border-ink/15 text-ink-soft hover:border-ink hover:text-ink'}"
				aria-pressed={showCentroids}
				onclick={() => (showCentroids = !showCentroids)}
			>
				<span class="mr-1">◆</span> Centroids
			</button>

			<select
				class="border-ink/15 bg-paper focus:border-accent rounded-full border px-4 py-2.5 text-sm font-bold outline-none"
				bind:value={selectedCluster}
				onchange={() => {
					selectedPoint = null;
					hoveredMarker = null;
				}}
				aria-label="Filter cluster"
			>
				<option value="all">All clusters</option>
				{#each projection?.clusters ?? [] as cluster (cluster.id)}
					<option value={cluster.id}>#{cluster.id} {cluster.name}</option>
				{/each}
			</select>

			<button
				class="border-ink/15 text-ink-soft hover:border-ink hover:text-ink rounded-full border px-4 py-2.5 text-sm font-bold transition"
				onclick={resetView}>Reset view</button
			>
		</div>
	</div>

	{#if loading}
		<div class="bg-paper/60 flex h-[520px] items-center justify-center">
			<div class="text-center">
				<div
					class="border-ink/10 border-t-accent mx-auto size-10 animate-spin rounded-full border-4"
				></div>
				<p class="mt-4 text-sm font-bold">Projecting centered embeddings…</p>
			</div>
		</div>
	{:else if error}
		<div class="bg-paper/60 flex h-[360px] items-center justify-center px-6 text-center">
			<div>
				<p class="text-ink font-bold">{error}</p>
				<p class="text-faded mt-1 text-sm">
					The raw embedding data is safe; try rebuilding the atlas.
				</p>
			</div>
		</div>
	{:else}
		<div class="bg-paper/65 relative" bind:this={container}>
			<canvas
				bind:this={canvas}
				class="block h-[520px] w-full touch-none outline-none sm:h-[600px]"
				tabindex="0"
				aria-label="{mode === '3d'
					? 'Three-dimensional'
					: 'Two-dimensional'} interactive cluster projection with track samples and centroid markers. Use pointer to rotate or pan, scroll to zoom, select a track, or focus a cluster from its centroid."
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
				onpointerleave={onPointerLeave}
				onwheel={onWheel}
				onkeydown={onKeyDown}
				ondblclick={resetView}
			></canvas>

			<div
				class="bg-paper/85 text-faded pointer-events-none absolute bottom-3 left-3 rounded-xl px-3 py-2 text-[10px] font-bold tracking-[0.12em] uppercase backdrop-blur"
			>
				{#if projection}
					PC1 {((projection.explainedVariance[0] ?? 0) * 100).toFixed(1)}% · PC2 {(
						(projection.explainedVariance[1] ?? 0) * 100
					).toFixed(1)}%
					{#if mode === '3d'}
						· PC3 {((projection.explainedVariance[2] ?? 0) * 100).toFixed(1)}%
					{/if}
				{/if}
			</div>

			<div
				class="bg-ink/80 text-cream pointer-events-none absolute top-3 left-3 rounded-full px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] uppercase backdrop-blur"
			>
				{visiblePoints.length.toLocaleString()} points{#if showCentroids}
					· {visibleCentroids.length} centroids{/if}
			</div>

			<div
				class="bg-paper/85 text-faded pointer-events-none absolute right-3 bottom-3 rounded-xl px-3 py-2 text-[10px] font-bold tracking-[0.1em] uppercase backdrop-blur"
			>
				<span class="mr-3"><span class="text-accent mr-1">●</span> Track</span>
				{#if showCentroids}<span><span class="text-accent mr-1">◆</span> Centroid</span>{/if}
			</div>

			{#if hoveredMarker}
				<div
					class="border-ink/10 bg-paper/95 pointer-events-none absolute z-10 w-64 rounded-2xl border p-3 shadow-xl backdrop-blur"
					style:left="{Math.min(Math.max(12, hoveredMarker.x + 14), Math.max(12, width - 270))}px"
					style:top="{Math.min(Math.max(12, hoveredMarker.y + 14), Math.max(12, height - 120))}px"
				>
					{#if hoveredMarker.kind === 'centroid'}
						<p class="truncate font-bold">Cluster centroid</p>
						<p class="text-ink-soft truncate text-xs">Full-library cluster center</p>
						<p
							class="text-accent-deep mt-1 truncate text-[10px] font-bold tracking-[0.12em] uppercase"
						>
							#{hoveredMarker.centroid.clusterId}
							{clusterName(hoveredMarker.centroid.clusterId)}
						</p>
					{:else}
						<p class="truncate font-bold">{hoveredMarker.point.name}</p>
						<p class="text-ink-soft truncate text-xs">{hoveredMarker.point.artists.join(', ')}</p>
						<p
							class="text-accent-deep mt-1 truncate text-[10px] font-bold tracking-[0.12em] uppercase"
						>
							#{hoveredMarker.point.clusterId}
							{clusterName(hoveredMarker.point.clusterId)}
						</p>
					{/if}
				</div>
			{/if}
		</div>

		<div class="border-ink/10 border-t p-5 sm:p-6">
			{#if selectedPoint}
				<div
					class="bg-ink text-cream flex flex-wrap items-center justify-between gap-4 rounded-2xl p-4 sm:p-5"
				>
					<div class="min-w-0">
						<p class="font-display truncate text-xl font-black">{selectedPoint.name}</p>
						<p class="text-cream/70 truncate text-sm">{selectedPoint.artists.join(', ')}</p>
						<p class="text-cream/50 mt-1 truncate text-xs">
							{selectedPoint.album} · #{selectedPoint.clusterId}
							{clusterName(selectedPoint.clusterId)}
						</p>
					</div>
					<div class="flex gap-2">
						<button
							class="bg-cream/10 hover:bg-cream/20 rounded-full px-4 py-2 text-sm font-bold transition disabled:opacity-50"
							onclick={() => (selectedPoint = null)}>Close</button
						>
						<button
							class="bg-accent text-cream hover:bg-accent-deep rounded-full px-5 py-2 text-sm font-bold transition disabled:opacity-50"
							disabled={playing}
							onclick={playSelected}>{playing ? 'Starting…' : '▶ Play track'}</button
						>
					</div>
				</div>
			{:else}
				<div class="text-faded flex flex-wrap items-center justify-between gap-3 text-sm">
					<p>
						{mode === '3d'
							? 'Drag to orbit · Shift-drag to pan · Scroll to zoom'
							: 'Drag to pan · Scroll to zoom · Double-click to reset'}
					</p>
					<p>Click a track to inspect it · Click a centroid to focus its cluster</p>
				</div>
			{/if}
		</div>
	{/if}
</section>
