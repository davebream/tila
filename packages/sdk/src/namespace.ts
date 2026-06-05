/**
 * Namespace coexistence convention for @tila/sdk.
 *
 * createNamespace(client, projectId, ns) returns {tasks, records, artifacts, templates}
 * where every declared name (work-unit type, record type, artifact kind,
 * template name/template_name) is prefixed with `${ns}_` on write and stripped on read.
 *
 * Relationship type, resource, file:, mime_type, ids, keys, slots are NEVER prefixed.
 */

import { createArtifactMethods } from "./artifacts";
import { TilaApiError, type TilaClient } from "./client";
import { createTaskMethods } from "./entities";
import {
  applyPrefix,
  stripPrefix,
  validateNamespace,
} from "./namespace-prefix";
import { createRecordMethods } from "./records";
import { createTemplateMethods } from "./templates";

// ---------------------------------------------------------------------------
// Task adapter
// ---------------------------------------------------------------------------

export function namespacedTaskMethods(
  client: TilaClient,
  projectId: string,
  ns: string,
) {
  const inner = createTaskMethods(client, projectId);

  return {
    ...inner,

    async create(id: string, type: string, data?: Record<string, unknown>) {
      const result = await inner.create(id, applyPrefix(ns, type), data);
      return {
        ...result,
        entity: { ...result.entity, type: stripPrefix(ns, result.entity.type) },
      };
    },

    async get(id: string) {
      const result = await inner.get(id);
      return {
        ...result,
        entity: { ...result.entity, type: stripPrefix(ns, result.entity.type) },
      };
    },

    async update(id: string, data: Record<string, unknown>, fence: number) {
      const result = await inner.update(id, data, fence);
      return {
        ...result,
        entity: { ...result.entity, type: stripPrefix(ns, result.entity.type) },
      };
    },

    async list(query?: {
      type?: string;
      status?: string;
      limit?: string;
      cursor?: string;
    }) {
      const prefixedQuery = query
        ? {
            ...query,
            type:
              query.type !== undefined
                ? applyPrefix(ns, query.type)
                : undefined,
          }
        : undefined;
      const result = await inner.list(prefixedQuery);
      return {
        ...result,
        entities: result.entities.map((e) => ({
          ...e,
          type: stripPrefix(ns, e.type),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Record adapter
// ---------------------------------------------------------------------------

export function namespacedRecordMethods(
  client: TilaClient,
  projectId: string,
  ns: string,
) {
  const inner = createRecordMethods(client, projectId);

  function stripRecordType<T extends { record: { type: string } }>(
    result: T,
  ): T {
    return {
      ...result,
      record: { ...result.record, type: stripPrefix(ns, result.record.type) },
    };
  }

  return {
    async create(type: string, req: Parameters<typeof inner.create>[1]) {
      return stripRecordType(await inner.create(applyPrefix(ns, type), req));
    },

    async set(type: string, key: string, req: Parameters<typeof inner.set>[2]) {
      return stripRecordType(await inner.set(applyPrefix(ns, type), key, req));
    },

    async get(type: string, key: string) {
      return stripRecordType(await inner.get(applyPrefix(ns, type), key));
    },

    async patch(
      type: string,
      key: string,
      req: Parameters<typeof inner.patch>[2],
    ) {
      return stripRecordType(
        await inner.patch(applyPrefix(ns, type), key, req),
      );
    },

    async archive(
      type: string,
      key: string,
      req: Parameters<typeof inner.archive>[2],
    ) {
      return stripRecordType(
        await inner.archive(applyPrefix(ns, type), key, req),
      );
    },

    async unarchive(
      type: string,
      key: string,
      req: Parameters<typeof inner.unarchive>[2],
    ) {
      return stripRecordType(
        await inner.unarchive(applyPrefix(ns, type), key, req),
      );
    },

    async history(
      type: string,
      key: string,
      opts?: Parameters<typeof inner.history>[2],
    ) {
      const result = await inner.history(applyPrefix(ns, type), key, opts);
      return {
        ...result,
        items: result.items.map((item) => ({
          ...item,
          type: stripPrefix(ns, item.type),
        })),
      };
    },

    async list(type: string, query?: Parameters<typeof inner.list>[1]) {
      const result = await inner.list(applyPrefix(ns, type), query);
      return {
        ...result,
        items: result.items.map((item) => ({
          ...item,
          type: stripPrefix(ns, item.type),
        })),
      };
    },

    async types() {
      const result = await inner.types();
      return {
        ...result,
        types: result.types.map((t) => stripPrefix(ns, t)),
      };
    },

    async typesInUse() {
      const result = await inner.typesInUse();
      return {
        ...result,
        types: result.types.map((t) => stripPrefix(ns, t)),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Artifact adapter
// ---------------------------------------------------------------------------

export function namespacedArtifactMethods(
  client: TilaClient,
  projectId: string,
  ns: string,
) {
  const inner = createArtifactMethods(client, projectId);

  return {
    ...inner,

    upload(
      input: File | Blob | ReadableStream,
      opts: Parameters<typeof inner.upload>[1] & { mimeType?: string },
    ) {
      return (
        inner.upload as (
          i: File | Blob | ReadableStream,
          o: typeof opts,
        ) => ReturnType<typeof inner.upload>
      )(input, { ...opts, kind: applyPrefix(ns, opts.kind) });
    },

    async writeText(
      content: string,
      opts: Parameters<typeof inner.writeText>[1],
    ) {
      // No strip on response — ArtifactPutResponse has no kind
      return inner.writeText(content, {
        ...opts,
        kind: applyPrefix(ns, opts.kind),
      });
    },

    async list(query?: Parameters<typeof inner.list>[0]) {
      const prefixedQuery = query
        ? {
            ...query,
            kind:
              query.kind !== undefined
                ? applyPrefix(ns, query.kind)
                : undefined,
          }
        : undefined;
      const result = await inner.list(prefixedQuery);
      return {
        ...result,
        pointers: result.pointers.map((p) => ({
          ...p,
          kind: stripPrefix(ns, p.kind),
        })),
      };
    },

    async search(q: string, opts?: Parameters<typeof inner.search>[1]) {
      const prefixedOpts = opts
        ? {
            ...opts,
            kind:
              opts.kind !== undefined ? applyPrefix(ns, opts.kind) : undefined,
          }
        : undefined;
      const result = await inner.search(q, prefixedOpts);
      return {
        ...result,
        results: result.results.map((r) => ({
          ...r,
          kind: stripPrefix(ns, r.kind),
        })),
      };
    },

    async grep(pattern: string, opts?: Parameters<typeof inner.grep>[1]) {
      const prefixedOpts = opts
        ? {
            ...opts,
            kind:
              opts.kind !== undefined ? applyPrefix(ns, opts.kind) : undefined,
          }
        : undefined;
      const result = await inner.grep(pattern, prefixedOpts);
      return {
        ...result,
        results: result.results.map((r) => ({
          ...r,
          kind: stripPrefix(ns, r.kind),
        })),
      };
    },

    async getLatest(kind: string, resource: string) {
      let pointer: Awaited<ReturnType<typeof inner.getLatest>>;
      try {
        pointer = await inner.getLatest(applyPrefix(ns, kind), resource);
      } catch (err) {
        // getLatest returns null on 404; if requestRaw threw before the null
        // check in artifacts.ts could run, intercept it here.
        if (err instanceof TilaApiError && err.status === 404) return null;
        throw err;
      }
      if (pointer === null) return null;
      return { ...pointer, kind: stripPrefix(ns, pointer.kind) };
    },
  };
}

// ---------------------------------------------------------------------------
// Template adapter
// ---------------------------------------------------------------------------

export function namespacedTemplateMethods(
  client: TilaClient,
  projectId: string,
  ns: string,
) {
  const inner = createTemplateMethods(client, projectId);

  return {
    ...inner,

    async instantiate(req: Parameters<typeof inner.instantiate>[0]) {
      return inner.instantiate({
        ...req,
        template_name: applyPrefix(ns, req.template_name),
      });
    },

    async list() {
      const result = await inner.list();
      return {
        ...result,
        templates: result.templates.map((t) => ({
          ...t,
          name: stripPrefix(ns, t.name),
          type: stripPrefix(ns, t.type),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export function createNamespace(
  client: TilaClient,
  projectId: string,
  ns: string,
) {
  validateNamespace(ns);
  return {
    tasks: namespacedTaskMethods(client, projectId, ns),
    records: namespacedRecordMethods(client, projectId, ns),
    artifacts: namespacedArtifactMethods(client, projectId, ns),
    templates: namespacedTemplateMethods(client, projectId, ns),
  };
}
