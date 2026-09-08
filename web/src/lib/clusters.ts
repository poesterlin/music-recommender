export const CLUSTER_NAMES: Record<number, string> = {
	[-1]: 'Wildcards',
	0: 'Skits, Interludes & Hip-Hop Bits',
	1: 'Emotive Pop & Classic Anthems',
	2: 'Smooth Grooves & Global Pop',
	3: 'Cinematic & Atmospheric Pop',
	4: 'German Pop & Boy Band Classics',
	5: 'Eclectic Rock & Instrumental Textures',
	6: 'Sophisticated Pop & Easy Listening',
	7: 'Energetic Rock & Post-Grunge',
	8: 'Classic Legends & Introspective Folk',
	9: 'Modern R&B & Contemporary Pop',
	10: 'Emotional Ballads & Indie Folk',
	11: 'Moody Alternative & R&B',
	12: '2000s Radio Rock & Pop-Rap',
	13: 'Britpop, Punk & Energetic Alt',
	14: 'High-Energy Dance & Club Pop',
	15: 'Uplifting Pop-Rock & Catchy Hits',
	16: 'Atmospheric Hip-Hop & Ethereal Pop',
	17: 'Vintage Rock & Psychedelic 60s/70s',
	18: 'Mainstream Pop & Big Radio Hits',
	19: '80s Pop-Rock & Melodic Legends',
	20: 'Modern Pop & Chill Trap-Pop',
	21: 'Quirky Pop & Modern Synth-Pop',
	22: 'Funky Hip-Hop & Rap-Pop',
	23: 'Melodic R&B & Contemporary Breezy Pop',
	24: 'Hard-Hitting Hip-Hop & Urban Dance',
	25: 'Vintage Pop & Clean Melodic Hits',
	26: 'Intense Rock-Rap & Dramatic Vibe',
	27: 'Whimsical Indie-Pop & Soft Acoustic',
	28: 'Modern Eclectic Pop & Smooth Vocals',
	29: 'Aggressive Rock & Punk Energy',
	30: 'Sophisticated Electronic & New Wave',
	31: 'Stripped-Back Vocals & Piano Ballads',
	32: 'High-Octane Rock & Stadium Anthems',
	33: 'Graceful & Orchestral Pop',
	34: 'Deep House & Groovy Club Beats',
	35: 'Gentle Indie-Folk & Soft Vintage Rock',
	36: 'Moody Dream Pop & Atmospheric Indie',
	37: 'Artistic & Cinematic Pop-R&B',
	38: 'Upbeat Pop-Rock & Classic Hooks',
	39: 'Raw Acoustic & Bluesy Folk',
	40: 'Dark R&B & Ethereal Soul',
	41: 'Symphonic Pop & Dramatic Ballads',
	42: 'Hard EDM & Aggressive Techno-Pop',
	43: 'Indie Rock & Modern Driving Pop',
	44: 'Fast-Flow Hip-Hop & Trap Energy',
	45: 'Modern Pop-R&B Fusion',
	46: 'Singer-Songwriter & Modern Emotional Pop',
	47: 'Progressive & Complex Rock',
	48: 'Polished 90s/00s Melodic Rock',
	49: 'Theatrical Rock & Arena Anthems',
	50: 'Charismatic Pop & Timeless Grooves',
	51: 'Party EDM & Hands-Up Dance',
	52: 'Orchestral & Grandiose Arrangements',
	53: 'Acoustic Rock & Vulnerable Pop',
	54: 'Psychedelic Pop & Experimental Indie',
	55: 'Art-Pop & Funky New Wave',
	56: 'Radio-Friendly Pop-Rock Hits',
	57: 'Urban Classics & Funky Rap',
	58: 'Emotive Modern Pop & Cinematic Beats',
	59: 'Garage Rock & Upbeat Indie'
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
