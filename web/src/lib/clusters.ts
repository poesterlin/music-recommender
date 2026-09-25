export const CLUSTER_NAMES: Record<number, string> = {
	[-1]: 'Wildcards',
	0: 'Raw Rap, Skits & Spoken Tracks',
	1: 'Polished Classic Guitar Rock',
	2: 'Fast, Driving Guitar Rock',
	3: 'Sophisticated Melodic Pop-Rock',
	4: 'Moody, Spacious Modern Pop',
	5: 'Bright, Polished Mainstream Pop',
	6: 'Spacious Cinematic Rock & Electronica',
	7: 'Sparse, Emotional Vocal Pop',
	8: 'Smooth, Soulful Pop & Soft Rock',
	9: 'Driving Dancefloor Electronica',
	10: 'Ethereal, Lush Art Pop',
	11: 'Mainstream Club Pop & Eurodance',
	12: 'Big-Hooked Anthemic Pop-Rock',
	13: 'Warm, Acoustic Adult Pop',
	14: 'Dramatic Anthemic Arena Rock',
	15: 'Anthemic Piano Pop & Soft Rock',
	16: 'Dark Polished R&B-Pop',
	17: 'Piano-Led Adult Ballads',
	18: 'Mellow Classic Pop-Rock',
	19: 'Theatrical Hybrid Rock-Pop',
	20: 'Bright Upbeat Guitar Rock',
	21: 'Beat-Driven Urban Grooves',
	22: 'Glossy ’80s Synth-Pop Rock',
	23: 'Silky Sophisticated Pop & R&B',
	24: 'Funk-Infused Global Grooves',
	25: 'Moody Electro-Pop',
	26: 'Raw Organic Roots Rock',
	27: 'Bright Synth-Pop & New Wave',
	28: 'Polished Emotional Pop',
	29: 'Cinematic Psychedelic Rock-Pop',
	30: 'Polished Adult-Rock Ballads',
	31: 'Anthemic Heartland Rock & Adult Soul',
	32: 'Organic Soul & Intimate Ballads',
	33: 'Classic Rock & Grand Piano Pop',
	34: 'Warm Acoustic Pop & Singer-Songwriter',
	35: 'Bright Synth-Pop & Dance Hooks',
	36: 'Dark Melodic Rap-Pop',
	37: 'Nostalgic Piano-Pop & Soft Rock',
	38: 'Textured Indie & Alternative Pop',
	39: 'Sparse Atmospheric Electronica',
	40: 'Theatrical Pop-Rock & Electro-Rock',
	41: 'Bright Hook-Driven Pop-Rock',
	42: 'Hard-Driving Aggressive Rap',
	43: 'Upbeat Retro Funk & Disco-Pop',
	44: 'Bass-Heavy Future Dance-Pop',
	45: 'Hard-Driving Hip-Hop & Southern Rap',
	46: 'Lush Orchestral Pop-Rock',
	47: 'Dark, Heavy Hip-Hop',
	48: 'Energetic Alternative & Punk Rock',
	49: 'Glossy Modern Pop & R&B',
	50: 'Atmospheric Adult Pop & Soft Rock',
	51: 'Indie Folk & Chamber Pop',
	52: 'Synth-Infused Art Rock & New Wave',
	53: 'Stadium Rock & Power Ballads',
	54: 'Britpop & Alternative Rock',
	55: 'Verse-Driven Hip-Hop',
	56: 'Anthemic Guitar Pop-Rock',
	57: '1960s British Pop-Rock',
	58: 'Indie Rock & Electronic Crossover',
	59: 'Glossy Dance-Pop & Urban Pop'
};

export function clusterLabel(id: number): string {
	return `#${id} ${CLUSTER_NAMES[id] ?? 'Cluster ' + id}`;
}

export type Track = {
	uri: string;
	name: string;
	artists: string[];
	album?: string;
	clusterId?: number;
	similarity?: number;
};

export type VibeSchedule = {
	id: number;
	name: string;
	startHour: number;
	endHour: number;
	clusterIds: number[];
	enabled?: boolean | null;
};
