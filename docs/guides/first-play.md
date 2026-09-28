# Your first playable vibe

After [local installation](/getting-started/local), sign in to Sole and open **Setup** (`/setup`). Make sure `MUSIC_HOST` and `MA_TOKEN` are set in `.env` as described in the install guide. Music Assistant supplies the catalogue and playback; Sole uses your read-only music mount to prepare short audio snippets for analysis.

## 1. Start Setup

Click **Start setup**. Sole checks the database, refreshes Music Assistant, and indexes your tracks. You can close this page while it works. If a step fails, fix the cause shown there, then click **Continue setup**. You can also click **Run this step again**, followed by **Continue setup**.

![The Setup checklist with analysis, grouping, naming, and the Start setup button](/images/first-play/setup.jpg)

*Example from an established library. Your counts and button label may differ.*

## 2. Start audio analysis

The local install does not start an analysis worker automatically. From the **sole folder on your computer** (the one containing `compose.yaml` and `.env`), run:

```sh
docker compose --profile worker up -d
```

The worker downloads short snippets from Sole and sends back its analysis. It uses the `WORKER_TOKEN` you generated in `.env` during local installation; **you do not need to create a key in the app**. The worker does not need your music folder or database, and you do not need to open a container shell.

On **Setup**, **Wait for audio analysis** may show **Waiting** for a while. The app checks again about once a minute, even if you close the browser. Open **Worker** (`/status`) to watch **Embedded** and **Pending**. Large libraries take time; **Skipped** tracks are counted separately.

![The Worker page showing analysis coverage and progress](/images/first-play/worker.jpg)

Running the worker on another machine? Create an **Embedding worker API** key under **Manage → API keys** instead, then follow [Embedding workers](/guides/worker).

## 3. Check the centered space

Setup needs **centered** tracks to make vibes. On **Worker**, once a useful batch has been analysed (aim for 200 **Embedded** tracks for a large library), click **Preview**, then **Create the centered space**. This needs at least two analysed tracks. Check that the small **centered** count under the progress bar rises. If the page instead offers **Center the remaining embeddings**, use that button.

Return to **Setup**. It starts grouping after **200 centered, eligible tracks**, or after all eligible tracks are centered in a smaller library. **Check again** resumes it right away; use that button if the app restarted while waiting. A library needs at least two analysable tracks to create a centered space.

## 4. Let Setup group and name the vibes

**Group tracks into vibes** chooses a cluster count from the size of your analyzed library and groups the tracks. **Name the vibes** gives each group an editable starting name based on its artists. The **Check cover art** step only reports coverage. When Setup says **You're set up**, click **Open your vibes**, or use **Vibe → Browse** to inspect them. Click a tile to change its name; preview a group before playing it.

![The Vibe Browse tab with named groups of tracks](/images/first-play/vibes.jpg)

You can start listening before every track is analyzed. Later, **Manage → Full tidy-up** assigns newly analyzed tracks to the existing vibes without changing earlier assignments. If no tracks appear or analysis stalls, see [Troubleshooting](/reference/troubleshooting).
