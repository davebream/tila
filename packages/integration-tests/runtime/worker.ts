import { DurableObject } from "cloudflare:workers";

export { default, ProjectDO } from "../../worker/src/index";

// Empty storage lets tests seed an old schema before invoking the real runner.
export class MigrationFixture extends DurableObject {}
