# Your first playable vibe

After [local installation](/getting-started/local), sign in to Sole and open **Setup** (`/setup`). Make sure `MUSIC_HOST` and `MA_TOKEN` are set in `.env` as described in the install guide. Music Assistant supplies the catalogue and playback; Sole uses your read-only music mount to prepare short audio snippets for analysis.

## 1. Start Setup

Click **Start setup**. The page checks the database, asks Music Assistant to refresh its library, indexes the tracks, and shows the result of each step. You can close the page while it works. If a step says **Failed**, read its detail, correct the cause, and click **Run this step again** (or **Continue setup**).

![The Setup checklist with analysis, grouping, naming, and the Start setup button](/images/first-play/setup.jpg)

*Example from an established library. Your counts and button label may differ.*

## 2. Start audio analysis

The local install does not start an analysis worker automatically. From the **sole folder on your computer** (the one containing `compose.yaml` and `.env`), run:

```sh
docker compose --profile worker up -d
```

This starts the optional worker in the background. It fetches short snippets from the app and sends back its analysis; it does not mount your music folder or connect to PostgreSQL. It uses the `WORKER_TOKEN` in `.env`. You do not need to open a shell inside a container.

On **Setup**, **Wait for audio analysis** may show **Waiting** for a while. The page checks again about once a minute while the app is running, even if you close your browser. The first pass can take a long time for a large library. Open **Worker** (`/status`) to see **Embedded**, **Pending**, and the progress bar. **Skipped** tracks are reported separately.

![The Worker page showing analysis coverage and progress](/images/first-play/worker.jpg)

If you run the worker elsewhere instead, create a Worker-scoped key under **Manage → API keys** and follow [Embedding workers](/guides/worker).

## 3. Check the centered space

Before Sole can compare tracks, it needs a *centered space* built from their analysis. On **Worker**, check the small **centered** count beneath the progress bar. If **Embedded** is above zero but **centered** is zero, the page offers **Preview** and **Create the centered space**. Once a useful batch has been analysed, click **Preview**, then **Create the centered space**. If some vectors remain uncentered later, use **Center the remaining embeddings** on the same page.

Return to **Setup**. It waits for at least **200 analyzed, centered tracks** before grouping a library that has more than 200 tracks. It resumes automatically while the app is running; **Check again** also resumes a paused run immediately. For a smaller library, it can proceed when every track is analyzed.

## 4. Let Setup group and name the vibes

**Group tracks into vibes** chooses a cluster count from the size of your analyzed library and groups the tracks. **Name the vibes** gives each group an editable starting name based on its artists. The **Check cover art** step only reports coverage. When Setup says **You're set up**, click **Open your vibes**, or use **Vibe → Browse** to inspect them. Click a tile to change its name; preview a group before playing it.

![The Vibe Browse tab with named groups of tracks](/images/first-play/vibes.jpg)

You can start listening before every track is analyzed. Later, **Manage → Full tidy-up** assigns newly analyzed tracks to the existing vibes without changing earlier assignments. If no tracks appear or analysis stalls, see [Troubleshooting](/reference/troubleshooting).
