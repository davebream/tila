export { ProjectDO } from "./project-do";
// Re-export from ops-sqlite for consumers that import from @tila/backend-do
export {
  schema as doSchema,
  relationshipOps,
  searchDriftOps,
} from "@tila/ops-sqlite";
