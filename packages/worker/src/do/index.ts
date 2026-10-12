export { ProjectDO } from "./project-do";
// Re-export from ops-sqlite for consumers that import from worker/src/do
export {
  schema as doSchema,
  relationshipOps,
  searchDriftOps,
} from "@tila/ops-sqlite";
