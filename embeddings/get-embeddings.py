import modal

# --- Modal App Definition ---
app = modal.App("r2-audio-embedding")
kv = modal.Dict.from_name("kv", create_if_missing=True)
vol = modal.Volume.from_name("result")


@app.function(volumes={"/data": vol})
def get_kv_fields():
    with open("/data/embeddings_updates.sql", "w") as out:
        out.write("-- Generated embeddings updates\n\n")
        tracks = kv.keys()
        for t in tracks:
            sql = (
                f"UPDATE track\n"
                f"SET embedding = '{kv[t]}'::vector\n"
                f"WHERE uri = '{t}';\n\n"
            )
            # print(sql)
            out.write(sql)
            out.flush()

@app.local_entrypoint()
def main():
    get_kv_fields.remote()