export type QueueTrack = {
	uri: string;
	name: string;
	album: string;
	artists: string[];
	similarity?: number;
	clusterId?: number | null;
};

let queue: QueueTrack[] = [];

export function getQueue(): QueueTrack[] {
	return queue;
}

export function setQueue(tracks: QueueTrack[]): void {
	queue = tracks;
}
