# Your first playable vibe

After [local installation](/getting-started/local), sign in to Sole and open **Setup** (`/setup`). Make sure `MUSIC_HOST` and `MA_TOKEN` are set in `.env` as described in the install guide. Music Assistant supplies the catalogue and playback; Sole uses your read-only music mount to prepare short audio snippets for analysis.

## 1. Start Setup

Setup is a live checklist. Use **Check database**, **Refresh Music Assistant**, and **Index library** as needed. Each button runs one action; there is no automatic sequence to resume. If an action fails, fix the cause and run it again. The checklist reflects the actual database rather than saved wizard progress.

![The Setup checklist with analysis, grouping, and naming (earlier interface)](/images/first-play/setup.jpg)

*Example from an established library. Your counts and button label may differ.*

## 2. Start audio analysis

The install already starts the analysis worker. To have it work through the library right now, from the **sole folder on your computer** (the one containing `compose.yaml` and `.env`), run:

```sh
docker compose up -d worker
```

The worker downloads short snippets from Sole and sends back its analysis. It uses the `WORKER_TOKEN` you generated in `.env` during local installation; **you do not need to create a key in the app**. The worker does not need your music folder or database, and you do not need to open a container shell.

On **Setup**, **Wait for audio analysis** may show **Waiting** for a while. The app checks again about once a minute, even if you close the browser. Open **Worker** (`/status`) to watch **Embedded** and **Pending**. Large libraries take time; **Skipped** tracks are counted separately.

![The Worker page showing analysis coverage and progress](/images/first-play/worker.jpg)

Running the worker on another machine? Create an **Embedding worker API** key under **Manage → API keys** instead, then follow [Embedding workers](/guides/worker).

## 3. Check the centered space

Setup needs **centered** tracks to make vibes. On **Worker**, once a useful batch has been analysed (aim for 200 **Embedded** tracks for a large library), click **Preview**, then **Create the centered space**. This needs at least two analysed tracks. Check that the small **centered** count under the progress bar rises. If the page instead offers **Center the remaining embeddings**, use that button.

Return to **Setup**. **Create vibes** becomes available after **200 centered, eligible tracks**, or after all eligible tracks are centered in a smaller library. Click it to group the library, then **Auto-name missing vibes** to label the groups from their dominant artists. Existing generations are left untouched. A library needs at least two analysable tracks to create a centered space.

## 4. Let Setup group and name the vibes

**Group tracks into vibes** chooses a cluster count from the size of your analyzed library and groups the tracks. **Name the vibes** gives each group an editable starting name based on its artists. The **Check cover art** step only reports coverage. When Setup says **You're set up**, click **Open your vibes**, or use **Vibe → Browse** to inspect them. Click a tile to change its name; preview a group before playing it.

![The Vibe Browse tab with named groups of tracks](/images/first-play/vibes.jpg)

You can start listening before every track is analyzed. Later, **Manage → Full tidy-up** assigns newly analyzed tracks to the existing vibes without changing earlier assignments. If no tracks appear or analysis stalls, see [Troubleshooting](/reference/troubleshooting).
