import { Model, registerModel } from "../sync/Model";
import type { Comment } from "./Comment";

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const PRIORITIES = [
  "No priority",
  "Urgent",
  "High",
  "Medium",
  "Low",
] as const;

/**
 * `declare` keeps these as type-only fields: the actual accessors are
 * defined on the prototype by registerModel (the observability helper),
 * so reads come from __data and writes are change-tracked for save().
 */
export class Issue extends Model {
  declare title: string;
  declare description: string;
  declare status: IssueStatus;
  declare priority: number;
  declare sortOrder: number;
  declare createdAt: string;
  declare updatedAt: string;

  /** One-to-many back-reference resolved through the Object Pool. */
  declare readonly comments: Comment[];
}

registerModel(Issue, {
  name: "Issue",
  loadStrategy: "instant",
  properties: {
    title: { type: "property", defaultValue: "" },
    description: { type: "property", defaultValue: "" },
    status: { type: "property", defaultValue: "backlog" },
    priority: { type: "property", defaultValue: 0 },
    sortOrder: { type: "property", defaultValue: 0 },
    createdAt: {
      type: "property",
      defaultValue: () => new Date().toISOString(),
    },
    updatedAt: {
      type: "property",
      defaultValue: () => new Date().toISOString(),
    },
  },
  referenceCollections: {
    comments: { referencedModel: "Comment", foreignKey: "issueId" },
  },
});
