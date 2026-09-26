#!/usr/bin/env python3
"""Expose FreeToken as a LocalAI-managed gRPC text-generation backend."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent import futures
from pathlib import Path

import grpc

import backend_pb2
import backend_pb2_grpc


class FreeTokenBackend(backend_pb2_grpc.BackendServicer):
    """One FreeToken engine, selected by the active LocalAI model config."""

    def __init__(self, host: str, port: int) -> None:
        self.url = f"http://{host}:{port}"
        self.host = host
        self.port = port
        self.process: subprocess.Popen | None = None
        self.model: str | None = None
        self.lock = threading.RLock()

    def Health(self, request, context):
        return backend_pb2.Reply(message=b"OK")

    @staticmethod
    def _options(values) -> dict[str, str]:
        return dict(item.split(":", 1) for item in values if ":" in item)

    @staticmethod
    def _model_ref(request) -> str:
        for value in (request.ModelFile, request.Model):
            if not value:
                continue
            path = Path(value)
            if path.exists():
                return str(path)
            model_path = Path(request.ModelPath or "/models") / value
            if model_path.exists():
                return str(model_path)
        raise ValueError(
            "FreeToken needs a LocalAI-downloaded Hugging Face safetensors directory; "
            "GGUF files stay on llama.cpp."
        )

    def _ready(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self.url}/v1/models", timeout=2) as response:
                return response.status == 200
        except (urllib.error.URLError, TimeoutError):
            return False

    def _stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None
        self.model = None

    def _start(self, model: str, options: dict[str, str]) -> None:
        command = [
            "ft", "serve", "--host", self.host, "--port", str(self.port),
            "--model", model, "--served-model-name", Path(model).name,
            "--max-running-requests", options.get("freetoken_max_running_requests", "1"),
        ]
        for option, flag in (
            ("freetoken_moe_strategy", "--moe-strategy"),
            ("freetoken_moe_cpu_layers", "--moe-cpu-layers"),
            ("freetoken_memory_ratio", "--memory-ratio"),
            ("freetoken_max_seq_len", "--max-seq-len-override"),
            ("freetoken_gpu", "--gpu"),
        ):
            if options.get(option):
                command.extend((flag, options[option]))
        self.process = subprocess.Popen(command, stdout=sys.stderr, stderr=sys.stderr)
        deadline = time.monotonic() + int(options.get("freetoken_start_timeout", "300"))
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"FreeToken exited with code {self.process.returncode}")
            if self._ready():
                self.model = model
                return
            time.sleep(1)
        self._stop()
        raise TimeoutError("FreeToken did not become ready within the configured timeout")

    def LoadModel(self, request, context):
        try:
            model = self._model_ref(request)
            options = self._options(request.Options)
            with self.lock:
                if self.model != model or not self._ready():
                    self._stop()
                    self._start(model, options)
            return backend_pb2.Result(success=True, message=f"FreeToken loaded {Path(model).name}")
        except Exception as error:
            return backend_pb2.Result(success=False, message=str(error))

    @staticmethod
    def _payload(request, stream: bool) -> dict:
        messages = [{"role": item.role, "content": item.content} for item in request.Messages]
        if not messages:
            messages = [{"role": "user", "content": request.Prompt}]
        payload = {"model": "localai-freetoken", "messages": messages, "stream": stream}
        if request.Tokens > 0:
            payload["max_tokens"] = request.Tokens
        if request.Temperature > 0:
            payload["temperature"] = request.Temperature
        if request.TopP > 0:
            payload["top_p"] = request.TopP
        if request.MinP > 0:
            payload["min_p"] = request.MinP
        if request.StopPrompts:
            payload["stop"] = list(request.StopPrompts)
        if request.FrequencyPenalty:
            payload["frequency_penalty"] = request.FrequencyPenalty
        if request.PresencePenalty:
            payload["presence_penalty"] = request.PresencePenalty
        if request.Tools:
            payload["tools"] = json.loads(request.Tools)
        return payload

    def _request(self, payload: dict):
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.url}/v1/chat/completions", data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        return urllib.request.urlopen(request, timeout=900)

    def Predict(self, request, context):
        try:
            with self.lock:
                if not self.model or not self._ready():
                    raise RuntimeError("No FreeToken model is loaded")
                with self._request(self._payload(request, False)) as response:
                    data = json.load(response)
            choice = data["choices"][0]
            text = choice.get("message", {}).get("content") or choice.get("text", "")
            usage = data.get("usage", {})
            return backend_pb2.Reply(message=text.encode(), tokens=usage.get("completion_tokens", 0), prompt_tokens=usage.get("prompt_tokens", 0))
        except Exception as error:
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(error))
            return backend_pb2.Reply()

    def PredictStream(self, request, context):
        try:
            with self.lock:
                if not self.model or not self._ready():
                    raise RuntimeError("No FreeToken model is loaded")
                response = self._request(self._payload(request, True))
            with response:
                for line in response:
                    if not line.startswith(b"data: "):
                        continue
                    event = line[6:].strip()
                    if event == b"[DONE]":
                        return
                    item = json.loads(event)
                    delta = item.get("choices", [{}])[0].get("delta", {})
                    text = delta.get("content") or ""
                    if text:
                        yield backend_pb2.Reply(message=text.encode())
        except Exception as error:
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(error))

    def Free(self, request, context):
        with self.lock:
            self._stop()
        return backend_pb2.Result(success=True, message="FreeToken stopped")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--addr", default="0.0.0.0:50051")
    parser.add_argument("--freetoken-host", default="127.0.0.1")
    parser.add_argument("--freetoken-port", type=int, default=1919)
    args = parser.parse_args()
    host, port = args.addr.rsplit(":", 1)
    backend = FreeTokenBackend(args.freetoken_host, args.freetoken_port)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
    backend_pb2_grpc.add_BackendServicer_to_server(backend, server)
    server.add_insecure_port(f"{host}:{port}")
    server.start()

    def shutdown(*_):
        backend._stop()
        server.stop(5)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    server.wait_for_termination()


if __name__ == "__main__":
    main()
