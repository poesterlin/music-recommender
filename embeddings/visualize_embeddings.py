import os
import json
import psycopg2
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import umap
from collections import Counter
from sklearn.metrics import silhouette_samples

# --- Configuration ---
CLUSTER_NAMES = {
  -1: "Wildcards",
  0: "Cinematic Ambient Textures",
  1: "Sunshine Legacy Pop",
  2: "Pure Narrative Skits",
  3: "Late Night Dance Pop",
  4: "Raw Alt-Rock & Demos",
  5: "Intimate Singer-Songwriter",
  6: "Future Bass & Glitch",
  7: "Sad-Girl Indie Cinema",
  8: "Ethereal Indie Folk",
  9: "Art-Pop Percussion",
  10: "Modern Pop Hits",
  11: "60s/70s Acoustic Foundations",
  12: "High-Energy Alt-Pop Anthems",
  13: "Experimental Soundscapes",
  14: "Piano Soul & Brit-Pop",
  15: "Slick Urban Crossover",
  16: "Mainstream Radio Hits",
  17: "Soft Acoustic Harmony",
  18: "Sophisticated Pop Soul",
  19: "Stadium Rock Radio",
  20: "Melancholic Sophisti-Pop",
  21: "Power Ballads & Pop Vocals",
  22: "Modern Summer R&B",
  23: "Electro-Pop Groove",
  24: "Funk-Infused Hip-Hop",
  25: "Quiet Indie Folk",
  26: "Mainstage EDM Instrumentals",
  27: "Mid-Tempo Modern Ballads",
  28: "Theatrical Arena Rock",
  29: "80s Adult Contemporary",
  30: "Roots Rock Strumming",
  31: "Punk-Pop Energizers",
  32: "Early British Invasion",
  33: "Neo-Soul & Downtempo",
  34: "Space Rock & Shoegaze",
  35: "Grunge & 90s Alternative",
  36: "Dark Rhythmic Flow",
  37: "Moody Indie Noir",
  38: "Dark Dream Pop",
  39: "Funk, Soul & Classic Groove",
  40: "High-Intensity Pop-Punk",
  41: "The New Atlanta Sound",
  42: "Aggressive Lyricism",
  43: "Moody Trap Anthems",
  44: "Fragile Chamber Pop",
  45: "British Rock & Roll Foundations",
  46: "Upbeat Synth-Pop",
  47: "Ethereal Modern Pop",
  48: "Avant-Garde Fragments",
  49: "Modern Adult Contemporary",
  50: "Acoustic Rock Anthems",
  51: "Indie-Pop Synth Crossover",
  52: "Modern Minimalist Electronic",
  53: "Folk-Soul Storytelling",
  54: "Hard Rock & Post-Grunge",
  55: "Funky Dance-Pop",
  56: "Monophonic Vintage Rock",
  57: "Cinematic Rap & Storytelling",
  58: "Modern Americana & Pop",
  59: "Lengthy Electronic Experiments",
}

FAMILIES = {
  "Rock": [4, 11, 19, 28, 31, 32, 34, 35, 40, 45, 50, 54, 56],
  "Urban": [15, 22, 24, 36, 41, 42, 43, 55, 57, 59],
  "Electronic": [3, 6, 12, 16, 23, 26, 46, 51, 52],
  "Atmospheric": [0, 7, 8, 13, 25, 27, 37, 38, 44, 48, 53],
  "Pop": [10, 14, 18, 21, 29, 30, 47, 49, 58],
  "Heritage": [1, 5, 9, 17, 20, 33, 39],
  "Utility": [2]
}

FAMILY_COLORS = {
    "Rock": "#E74C3C",
    "Urban": "#F1C40F",
    "Electronic": "#9B59B6",
    "Atmospheric": "#3498DB",
    "Pop": "#2ECC71",
    "Heritage": "#95A5A6",
    "Utility": "#7F8C8D"
}

def get_family_for_cluster(cid):
    for family, clusters in FAMILIES.items():
        if cid in clusters:
            return family
    return "Heritage"

def get_family_color(cid):
    family = get_family_for_cluster(cid)
    return FAMILY_COLORS.get(family, "#95A5A6")

def load_env_vars():
    if os.getenv("DATABASE_URL"): return
    env_path = ".env"
    if not os.path.exists(env_path): return
    print("Loading .env file...")
    vars_map = {}
    with open(env_path, "r") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                key, val = line.strip().split("=", 1)
                vars_map[key] = val.strip('"\'')
    
    if "TAILSCALE_DB_HOST" in vars_map:
        host = vars_map.get("TAILSCALE_DB_HOST")
        if host == "homelab": host = "100.82.130.136"
        db_url = f"postgresql://{vars_map.get('TAILSCALE_DB_USER', 'postgres')}:{vars_map.get('TAILSCALE_DB_PASSWORD', '')}@{host}:{vars_map.get('TAILSCALE_DB_PORT', '5432')}/{vars_map.get('TAILSCALE_DB_NAME', 'music')}"
        os.environ["DATABASE_URL"] = db_url

def parse_embedding(emb_str):
    return emb_str if isinstance(emb_str, list) else json.loads(emb_str)

def cosine_similarity(a, b):
    """Calculate cosine similarity between two vectors."""
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def calculate_cluster_cohesion(embeddings, cluster_ids, cid):
    """Calculate average within-cluster similarity."""
    cluster_embs = [embeddings[i] for i, c in enumerate(cluster_ids) if c == cid]
    if len(cluster_embs) < 2:
        return 1.0
    
    similarities = []
    for i in range(len(cluster_embs)):
        for j in range(i + 1, min(i + 20, len(cluster_embs))):  # Sample to avoid O(n²)
            similarities.append(cosine_similarity(cluster_embs[i], cluster_embs[j]))
    
    return np.mean(similarities) if similarities else 1.0
def main():
    load_env_vars()
    db_url = os.getenv("DATABASE_URL")
    if not db_url: return

    try:
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        print("Fetching tracks...")
        cur.execute("SELECT name, artist, album, embedding, cluster_id FROM track WHERE embedding IS NOT NULL")
        rows = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"DB Error: {e}")
        return

    data, embeddings, cluster_ids = [], [], []

    print(f"Processing {len(rows)} tracks...")
    for r in rows:
        name, artist, album, emb_raw, cluster_id = r
        cid = int(cluster_id) if cluster_id is not None else -1
        artist_str = ", ".join(artist) if isinstance(artist, list) else str(artist)
        
        try:
            vec = parse_embedding(emb_raw)
            embeddings.append(vec)
            cluster_ids.append(cid)
            data.append({
                "Track": str(name), 
                "Artist": str(artist_str), 
                "Album": str(album), 
                "ClusterID": cid,
                "Label": str(CLUSTER_NAMES.get(cid, f"Cluster {cid}"))
            })
        except: 
            continue

    print("Running UMAP...")
    reducer = umap.UMAP(
        n_components=2, 
        random_state=42, 
        n_neighbors=50,
        min_dist=0.3,
        spread=1.5,
        metric='cosine'
    )
    projections = reducer.fit_transform(embeddings)

    df = pd.DataFrame(data)
    df["x"] = projections[:, 0]
    df["y"] = projections[:, 1]
    df["embedding_idx"] = range(len(df))
    
    # Dynamic outlier removal
    x_95 = df['x'].quantile(0.95)
    df = df[df['x'] < x_95]

    print("Calculating cluster statistics...")
    cluster_stats = {}
    valid_cids = sorted([int(x) for x in df[df['ClusterID'] != -1]['ClusterID'].unique()])
    
    for cid in valid_cids:
        subset = df[df['ClusterID'] == cid]
        artists = []
        for idx in subset['embedding_idx']:
            artists.extend(data[idx]['Artist'].split(", "))
        
        top_artists = Counter(artists).most_common(3)
        # Simplified cohesion for speed
        cohesion = calculate_cluster_cohesion(embeddings, cluster_ids, cid)
        
        cluster_stats[str(cid)] = { # Use string keys for JSON safety
            "name": str(CLUSTER_NAMES.get(cid, f"Cluster {cid}")),
            "family": str(get_family_for_cluster(cid)),
            "size": int(len(subset)),
            "top_artists": [{"name": str(a), "count": int(c)} for a, c in top_artists],
            "cohesion": round(float(cohesion), 3),
            "center_x": float(subset['x'].median()),
            "center_y": float(subset['y'].median())
        }

    with open("cluster_stats.json", "w") as f:
        json.dump(cluster_stats, f, indent=2)
    print("Exported cluster_stats.json")

    print("Generating interactive plot...")
    fig = go.Figure()

    trace_indices = {f: [] for f in FAMILY_COLORS}
    all_indices = []

    # 1. Unclustered
    outliers = df[df['ClusterID'] == -1]
    if not outliers.empty:
        fig.add_trace(go.Scattergl(
            x=outliers['x'], y=outliers['y'],
            mode='markers',
            marker=dict(color='#333333', size=3, opacity=0.3),
            name='Unclustered',
            hovertext=outliers['Track'] + " - " + outliers['Artist'],
            hoverinfo='text'
        ))
        all_indices.append(len(fig.data) - 1)
        
    for family, color in FAMILY_COLORS.items():
        fig.add_trace(go.Scattergl(
            x=[None], y=[None], # Invisible points
            mode='markers',
            marker=dict(color=color),
            name=f"--- {family.upper()} ---", # Group Header Name
            legendgroup=family,
            showlegend=True
        ))
        trace_indices[family].append(len(fig.data) - 1)
        all_indices.append(len(fig.data) - 1)

    # 2. Clusters
    for cid_str, stats in cluster_stats.items():
        cid = int(cid_str)
        subset = df[df['ClusterID'] == cid]
        family = stats['family']
        
        fig.add_trace(go.Scattergl(
            x=subset['x'], y=subset['y'],
            mode='markers',
            marker=dict(color=get_family_color(cid), size=6, opacity=0.8),
            
            # 1. This name appears in the legend
            name=f"{cid}: {stats['name']}", 
            
            # 2. This groups them under the "Family" heading visually
            legendgroup=family, 
            
            # 3. Individual clusters can be hidden independently 
            # because we set groupclick='toggleitem' below
            showlegend=True, 

            text=[f"<b>{t}</b><br>{a}" for t, a in zip(subset['Track'], subset['Artist'])],
            hoverinfo='text'
        ))
        trace_indices[family].append(len(fig.data) - 1)
        all_indices.append(len(fig.data) - 1)

        if len(subset) > 5:
            fig.add_annotation(
                x=stats['center_x'], y=stats['center_y'],
                text=f"<b>{cid}</b><br>{stats['size']}",
                showarrow=False,
                font=dict(size=10, color='white'),
                bgcolor=get_family_color(cid),
                bordercolor="white" if stats['cohesion'] > 0.5 else "#FF6B6B",
                borderwidth=1.5,
                opacity=0.9
            )

    # Build Quick Toggle Buttons for the Dropdown
    family_buttons = [
        dict(label="[ SHOW ALL ]", method="restyle", args=[{"visible": True}, all_indices]),
        dict(label="[ HIDE ALL ]", method="restyle", args=[{"visible": "legendonly"}, all_indices]),
    ]
    for fam in FAMILY_COLORS:
        family_buttons.append(dict(
            label=f"Show {fam}",
            method="restyle",
            args=[{"visible": True}, trace_indices[fam]]
        ))
        family_buttons.append(dict(
            label=f"Hide {fam}",
            method="restyle",
            args=[{"visible": "legendonly"}, trace_indices[fam]]
        ))

    fig.update_layout(
        title="Music Library Vibe Map",
        template="plotly_dark",
        width=1800, height=1000,
        updatemenus=[dict(
            type="dropdown",
            direction="down",
            x=0.01, y=0.98,
            showactive=True,
            buttons=family_buttons,
            bgcolor="rgba(50, 50, 50, 0.9)",
            font=dict(color="white", size=11)
        )],
        legend=dict(
            itemsizing='constant',
            font=dict(size=9),
            # Set to 'toggleitem' to allow individual cluster toggling
            groupclick="toggleitem", 
            traceorder="grouped" 
        ),
        hovermode='closest'
    )
    
    fig.write_html("music_map_final.html")
    print("Done! Open 'music_map_final.html'")
    
    # Print stats summary
    print("\n--- Cluster Health Report ---")
    # Convert keys back to integers for sorting, or just sort the string keys
    for cid_str in sorted(cluster_stats.keys(), key=int):
        stats = cluster_stats[cid_str]
        cid = int(cid_str) # Convert back for the :2d formatter
        health = "✓ Healthy" if stats['cohesion'] > 0.6 else "⚠ Loose"
        print(f"Cluster {cid:2d} ({stats['family']:12s}): {stats['size']:4d} tracks | Cohesion: {stats['cohesion']:.3f} | {health}")

if __name__ == "__main__":
    main()