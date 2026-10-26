# The backup service: pg_dump from PostgreSQL 16, and the AWS command line to copy each backup off the
# server into object storage (S3, Mumbai region). Built by compose.prod.yml.
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends awscli && rm -rf /var/lib/apt/lists/*
