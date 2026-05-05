FROM openlock-core:latest

USER root

RUN HOME=/root bash -c "curl -fsSL https://bun.sh/install | bash" \
    && mv /root/.bun/bin/bun /usr/local/bin/ \
    && rm -rf /root/.bun

RUN corepack enable

USER sandbox
WORKDIR /sandbox
