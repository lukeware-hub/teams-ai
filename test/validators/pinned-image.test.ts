import { describe, expect, it } from 'vitest';
import { unpinnedBaseImages } from '../../server/validators/pinned-image.js';

describe('unpinnedBaseImages', () => {
  it('accepts a base image pinned by sha256 digest', () => {
    expect(unpinnedBaseImages('FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7\n')).toEqual([]);
  });

  it('accepts an explicit non-latest tag', () => {
    expect(unpinnedBaseImages('FROM node:22-bookworm\n')).toEqual([]);
  });

  it('rejects a bare image with no tag', () => {
    expect(unpinnedBaseImages('FROM node\n')).toEqual(['node']);
  });

  it('rejects an explicit :latest tag', () => {
    expect(unpinnedBaseImages('FROM node:latest\n')).toEqual(['node:latest']);
  });

  it('does not mistake a registry host port for a tag', () => {
    expect(unpinnedBaseImages('FROM registry.example.com:5000/node\n')).toEqual(['registry.example.com:5000/node']);
    expect(unpinnedBaseImages('FROM registry.example.com:5000/node:22\n')).toEqual([]);
  });

  it('checks every stage in a multi-stage build, but not a FROM referencing an earlier stage alias', () => {
    const dockerfile = [
      'FROM node:22-bookworm AS build',
      'RUN npm ci',
      'FROM node:latest AS runtime',
      'COPY --from=build /app /app',
    ].join('\n');
    expect(unpinnedBaseImages(dockerfile)).toEqual(['node:latest']);
  });

  it('skips a FROM that names an earlier stage, not a real image', () => {
    const dockerfile = ['FROM node:22-bookworm AS build', 'FROM build AS final'].join('\n');
    expect(unpinnedBaseImages(dockerfile)).toEqual([]);
  });

  it('handles --platform and is case-insensitive', () => {
    expect(unpinnedBaseImages('from --platform=linux/amd64 node:22-bookworm\n')).toEqual([]);
    expect(unpinnedBaseImages('FROM --platform=linux/amd64 node\n')).toEqual(['node']);
  });
});
