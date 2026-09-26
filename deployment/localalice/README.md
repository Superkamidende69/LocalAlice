# LocalAlice deployment

This Compose deployment runs the LocalAlice workspace: LocalAI, the optional
FreeToken runtime, and the distributed-controller services (PostgreSQL + NATS)
on one NVIDIA CUDA 13 host. It keeps model files, configurations, chats and
generated images outside the repository under `H:/LocalAI`.

Before starting it:

1. Copy `.env.example` to `.env` and replace both placeholder values with long,
   private random values. Do not commit `.env`.
2. Copy `external_backends.json` and `freetoken-model-template.yaml` into
   `H:/LocalAI/configuration/`.
3. Run:

```powershell
docker compose up -d
```

The controller is available on port 8080. NATS is published on port 4222 for
trusted worker machines on the same network. Distributed workers register with
the `LOCALAI_CLUSTER_TOKEN` from `.env`; each worker must expose port 50050 and
the configured worker gRPC range back to this controller.

FreeToken serves models selected through a LocalAI YAML configuration whose
backend is `freetoken`. The model must be a LocalAI-downloaded Hugging Face
safetensors directory or FreeToken FTW checkpoint; GGUF files continue to use
llama.cpp.
