import type { Model } from "./Model";

export type LoadStrategy =
  | "instant"
  | "lazy"
  | "partial"
  | "explicitlyRequested"
  | "local";

export type PropertyType = "property" | "ephemeralProperty" | "reference";

export interface PropertyMetadata {
  type: PropertyType;
  /** Persisted to IndexedDB and sent to the server (ephemeral properties are not). */
  persisted: boolean;
  /** Default value applied when constructing a fresh model. */
  defaultValue?: unknown;
  /** For references: the model this property points to (e.g. Comment.issueId -> "Issue"). */
  referencedModel?: string;
  /** For references: create an IndexedDB index on this property. */
  indexed?: boolean;
}

export interface ReferenceCollectionMetadata {
  /** The model on the other side (e.g. Issue.comments -> "Comment"). */
  referencedModel: string;
  /** The foreign key on the other model that points back at us (e.g. "issueId"). */
  foreignKey: string;
}

export interface ModelMetadata {
  name: string;
  loadStrategy: LoadStrategy;
  properties: Record<string, PropertyMetadata>;
  /** One-to-many collections resolved through the Object Pool. */
  referenceCollections: Record<string, ReferenceCollectionMetadata>;
}

export type ModelConstructor = new () => Model;

export interface ModelRegistration {
  name: string;
  loadStrategy?: LoadStrategy;
  properties: Record<
    string,
    Partial<PropertyMetadata> & { type?: PropertyType }
  >;
  referenceCollections?: Record<string, ReferenceCollectionMetadata>;
}

/**
 * The ModelRegistry is the dictionary of all model metadata: which models
 * exist, their properties, references, load strategies, and the schema hash
 * used to decide whether the local database needs a migration.
 */
class ModelRegistryClass {
  /** modelName -> constructor */
  private modelLookup = new Map<string, ModelConstructor>();
  /** modelName -> metadata */
  private metadataLookup = new Map<string, ModelMetadata>();

  registerModel(ctor: ModelConstructor, registration: ModelRegistration): void {
    const properties: Record<string, PropertyMetadata> = {};
    for (const [name, partial] of Object.entries(registration.properties)) {
      properties[name] = {
        type: partial.type ?? "property",
        persisted: partial.persisted ?? partial.type !== "ephemeralProperty",
        defaultValue: partial.defaultValue,
        referencedModel: partial.referencedModel,
        indexed: partial.indexed ?? false,
      };
    }

    const metadata: ModelMetadata = {
      name: registration.name,
      loadStrategy: registration.loadStrategy ?? "instant",
      properties,
      referenceCollections: registration.referenceCollections ?? {},
    };

    this.modelLookup.set(registration.name, ctor);
    this.metadataLookup.set(registration.name, metadata);
  }

  getConstructor(modelName: string): ModelConstructor {
    const ctor = this.modelLookup.get(modelName);
    if (!ctor) throw new Error(`ModelRegistry: unknown model "${modelName}"`);
    return ctor;
  }

  getMetadata(modelName: string): ModelMetadata {
    const meta = this.metadataLookup.get(modelName);
    if (!meta) throw new Error(`ModelRegistry: unknown model "${modelName}"`);
    return meta;
  }

  hasModel(modelName: string): boolean {
    return this.modelLookup.has(modelName);
  }

  allModelNames(): string[] {
    return [...this.metadataLookup.keys()];
  }

  modelsWithLoadStrategy(strategy: LoadStrategy): string[] {
    return this.allModelNames().filter(
      (name) => this.metadataLookup.get(name)!.loadStrategy === strategy,
    );
  }

  /**
   * Hash of every model's metadata. If it changes between sessions the local
   * IndexedDB schema no longer matches the code and the database is rebuilt
   * (followed by a fresh full bootstrap).
   */
  get schemaHash(): string {
    const parts: string[] = [];
    for (const name of this.allModelNames().sort()) {
      const meta = this.metadataLookup.get(name)!;
      parts.push(name, meta.loadStrategy);
      for (const [prop, propMeta] of Object.entries(meta.properties).sort(
        ([a], [b]) => a.localeCompare(b),
      )) {
        parts.push(
          prop,
          propMeta.type,
          String(propMeta.persisted),
          String(propMeta.indexed),
        );
      }
      for (const [coll, collMeta] of Object.entries(
        meta.referenceCollections,
      ).sort(([a], [b]) => a.localeCompare(b))) {
        parts.push(coll, collMeta.referencedModel, collMeta.foreignKey);
      }
    }
    // djb2 string hash, hex-encoded
    let hash = 5381;
    const input = parts.join("|");
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
  }
}

export const ModelRegistry = new ModelRegistryClass();
