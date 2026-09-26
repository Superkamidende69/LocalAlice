# FreeToken backend for LocalAI

This container is a LocalAI gRPC backend. LocalAI connects to it as
`freetoken: ftoken-backend:50051`; the adapter starts `ft serve` when a model
whose YAML says `backend: freetoken` is loaded.

FreeToken accepts Hugging Face safetensors directories or FTW checkpoints.
It does not accept GGUF, so existing LocalAI GGUF models continue to use
llama.cpp.

The adapter deliberately runs one FreeToken model at a time. Switching to a
different FreeToken model stops the previous one before loading the next.
