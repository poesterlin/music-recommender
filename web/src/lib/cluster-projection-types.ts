export type ClusterProjectionPoint = {
	uri: string;
	name: string;
	artists: string[];
	album: string;
	clusterId: number;
	x: number;
	y: number;
	z: number;
};

export type ClusterProjectionCluster = {
	id: number;
	name: string;
	trackCount: number;
	sampleCount: number;
	legacyClusterId?: number;
	legacyName?: string;
	matchConfidence?: number;
};

export type ClusterProjectionCentroid = {
	clusterId: number;
	x: number;
	y: number;
	z: number;
};

export type ClusterProjectionData = {
	generatedAt: string;
	activeRun?: {
		id: number;
		k: number;
		trackCount: number;
		status: string;
	};
	projection: 'pca';
	dimensions: number;
	pointCount: number;
	perCluster: number;
	explainedVariance: number[];
	clusters: ClusterProjectionCluster[];
	centroids: ClusterProjectionCentroid[];
	points: ClusterProjectionPoint[];
};
