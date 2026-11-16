ARG PROJECT_IMAGE
# PROJECT_IMAGE is the maintained, credential-free project tool image selected
# by Core. Model packaging and provider authentication belong to AGENT-3.
FROM python:3.13.7-slim-bookworm AS python
FROM ${PROJECT_IMAGE}
COPY --from=python /usr/local /usr/local
COPY src/claude-work-worker.py src/claude-work-protocol.py \
     src/claude-work-files.py src/claude-work-limits.json /opt/nibfin/work/
RUN /usr/local/bin/python3 --version
ENTRYPOINT ["/usr/local/bin/python3", "-I", "-B", \
            "/opt/nibfin/work/claude-work-worker.py"]
