# Run proofs in locked containers

Status: Accepted
Date: 2026-09-07

## Context

Proof code comes from a pull request and must be treated as hostile. Running it with
the local command runner would give it the developer's filesystem, network, and user
authority. Docker also applies no CPU or memory limits by default, and its default
logging driver can consume unbounded daemon disk space. See Docker's
[resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
and [logging configuration](https://docs.docker.com/engine/logging/configure/).

## Decision

Image preparation is an explicit step. It pulls one digest-pinned image using an empty
temporary Docker configuration, without repository source or host credentials. Runtime
execution uses that local image with `--pull never`.

Base and head use the same image, entrypoint, arguments, environment, and limits. Each
container has no network, a read-only root filesystem and repository mount, no effective
capabilities, no new privileges, no IPC namespace, a numeric non-root user, and bounded
CPU, memory, process count, file descriptors, output, time, and writable temporary space.
Docker's [none network](https://docs.docker.com/engine/network/drivers/none/) leaves only
loopback, while the [run reference](https://docs.docker.com/reference/cli/docker/container/run/)
defines the remaining flags.

Walkz overrides the image entrypoint with the approved executable and clears common
execution-control environment variables. Daemon logging is disabled; Walkz captures a
bounded stream directly. A named container is force-removed after every outcome, and a
separate daemon query verifies that it is gone.

## Options considered

- Host execution was rejected because it provides no filesystem or network boundary.
- Pulling an image during proof was rejected because it silently adds runtime network
  access and mutable external state.
- Relying only on `--rm` was rejected because killing the Docker client can leave the
  container running.
- Root or privileged containers were rejected because the proof needs neither authority.

## Consequences

The proof can still exploit a Docker Engine or kernel defect. Docker is a trust anchor,
not a risk-free boundary. The current slice also requires a local Linux container engine
and a preloaded compatible image. A root host may fail closed when its temporary files
cannot be read by the non-root container user.

Repository package installation is not automatic. Self-contained reproducers work now;
dependency preparation needs a separate approved command contract before it can be added.
