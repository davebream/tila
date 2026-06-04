declare module "object-treeify" {
  export default function treeify(
    obj: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): string;
}
