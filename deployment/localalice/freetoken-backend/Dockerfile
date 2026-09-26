FROM localai-h:talk

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/freetoken-localai
COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY backend.proto adapter.py ./
RUN python3 -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. backend.proto

ENV PYTHONUNBUFFERED=1
EXPOSE 50051
ENTRYPOINT ["python3", "/opt/freetoken-localai/adapter.py"]
