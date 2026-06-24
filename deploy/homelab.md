# Deploying to the homelab (Docker Swarm)

The app is a single container: Fastify serves the API and the built React
frontend, with SQLite on a volume.

It reads reward data from your **own beacon node** over the internal network, so
it must be on `homelab-private` (to reach `mainnet-lighthouse:5052` and
`mainnet-geth:8545`) as well as `homelab-public` (for Traefik). The only external
call is CoinGecko for ETH/fiat prices.

**Prerequisite:** for full history, `mainnet-lighthouse` must be an archive node
(`--reconstruct-historic-states`, already added to the compose). The app collects
what's reconstructed so far and fills the rest on later runs as reconstruction
progresses.

## Build the image

Swarm can't build from a local path on every node, so either:

**A. Build + push to a registry** (recommended), then reference the image:
```bash
docker build -t <registry>/stakingtracker:latest .
docker push <registry>/stakingtracker:latest
```

**B. Build from a git context** once the repo is pushed to GitHub:
```yaml
    build:
      context: https://github.com/ffaerber/stakingtracker.git
      dockerfile: Dockerfile
```

## Service block for `/mnt/rpool-homelab/docker-compose.yml`

```yaml
  stakingtracker:
    image: <registry>/stakingtracker:latest   # or use build: (option B)
    networks:
      - homelab-public
      - homelab-private
    volumes:
      - /mnt/homelab/stakingtracker:/data
    environment:
      - STT_DB_PATH=/data/stakingtracker.db
    deploy:
      placement:
        constraints:
          - node.hostname == node1
      replicas: 1
      restart_policy:
        condition: any
      resources:
        limits:
          cpus: "0.5"
          memory: 512M
      labels:
        - "traefik.enable=true"
        - "traefik.swarm.network=homelab-public"
        - "traefik.http.routers.stakingtracker.rule=Host(`staking.example.com`)"
        - "traefik.http.routers.stakingtracker.entrypoints=websecure"
        - "traefik.http.routers.stakingtracker.tls.certresolver=le"
        - "traefik.http.services.stakingtracker.loadbalancer.server.port=3000"
        # Reuse your existing admin basic-auth. Generate a hash with:
        #   htpasswd -nbB admin 'your-password' | sed -e 's/\$/\$\$/g'
        - "traefik.http.middlewares.stk-auth.basicauth.users=admin:<your-htpasswd-hash>"
        - "traefik.http.routers.stakingtracker.middlewares=stk-auth"
    logging:
      driver: loki
      options:
        loki-url: "http://<loki-host>:3100/loki/api/v1/push"
        loki-batch-size: "400"
        loki-retries: "5"
        loki-timeout: "5s"
```

> Auth is handled by the Traefik basic-auth middleware (matching your grafana /
> prometheus pattern), so the API key is gated behind login. The app also
> supports its own basic auth via `STT_USER`/`STT_PASS` env if you'd rather not
> use Traefik for it.

## Deploy

```bash
docker stack deploy -c /mnt/rpool-homelab/docker-compose.yml <your-stack-name>
```

Set your node URLs and validator indices via the `STT_*` env vars in the service
block (the Settings page is read-only). Then open `https://staking.example.com`
and click **Collect / Refresh data** on the Dashboard; the backend also
re-collects daily on its own.

## Backup

The whole dataset is the SQLite file at `/mnt/homelab/stakingtracker/`. Back up
that directory; restoring it restores all collected history + settings.
