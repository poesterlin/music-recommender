import { post } from '$lib/api';
import { toastStore } from '$lib/client/toast.svelte';

type LikeResponse = {
	success?: boolean;
	name?: string;
};

export async function likeTrack(uri: string, fallbackName?: string): Promise<boolean> {
	const { ok, data } = await post<LikeResponse>('/track/like', {
		uri,
		source: 'web'
	});

	if (ok) {
		toastStore.show(`Liked ${data.name ?? fallbackName ?? 'track'} — spun into future mixes`);
	}

	return ok;
}
