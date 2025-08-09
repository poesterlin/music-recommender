import modal

app = modal.App("gpu-test")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "tensorflow==2.15.0",
    )
)

@app.function(gpu="T4", image=image)
def check_gpu():
    import tensorflow as tf
    print("Visible GPUs:", tf.config.list_physical_devices("GPU"))

@app.local_entrypoint()
def main():
    check_gpu.remote()