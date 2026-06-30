import { getSyncContext } from "../sync/context";
import { Model, registerModel } from "../sync/Model";
import type { Issue } from "./Issue";

export class Comment extends Model {
  declare body: string;
  declare issueId: string;
  declare author: string;
  declare createdAt: string;
  declare updatedAt: string;

  /** Reference resolved through the Object Pool by UUID. */
  get issue(): Issue | undefined {
    return getSyncContext().pool.get(this.issueId) as Issue | undefined;
  }
}

registerModel(Comment, {
  name: "Comment",
  loadStrategy: "instant",
  properties: {
    body: { type: "property", defaultValue: "" },
    issueId: { type: "reference", referencedModel: "Issue", indexed: true },
    author: { type: "property", defaultValue: "anonymous" },
    createdAt: {
      type: "property",
      defaultValue: () => new Date().toISOString(),
    },
    updatedAt: {
      type: "property",
      defaultValue: () => new Date().toISOString(),
    },
  },
});
