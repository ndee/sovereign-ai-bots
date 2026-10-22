import { z } from "zod";

export const commandSchema = z.enum(["lint", "typecheck", "test", "smoke"]);

const manifestKindSchema = z.literal("sovereign-bot-package");
const matrixIdentityModeSchema = z.enum(["service-account", "dedicated-account"]);
const hostResourceKindSchema = z.enum([
  "directory",
  "managedFile",
  "stateFile",
  "systemdService",
  "systemdTimer",
  "openclawCron",
]);
const finiteNumberSchema = z
  .number()
  .refine(Number.isFinite, { message: "must be a finite number" });
const finiteScalarSchema = z.union([z.string(), z.boolean(), finiteNumberSchema]);
const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must not be empty",
});
const bindingSchema = z
  .object({
    from: nonEmptyStringSchema,
    stringify: z.boolean().optional(),
  })
  .passthrough();
const bindingMapSchema = z.record(z.string(), bindingSchema);
const toolTemplateRefSchema = z
  .object({
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
  })
  .passthrough();
// Node renders the typed tool and enforces its full rules; the catalog checks
// the shape so a malformed declaration fails here, before it reaches a node.
const typedToolParamSchema = z
  .object({
    type: z.enum(["string", "boolean"]),
    description: nonEmptyStringSchema,
    enum: z.array(nonEmptyStringSchema).min(1).optional(),
    pattern: nonEmptyStringSchema.optional(),
    maxLength: z.number().int().min(1).max(500).optional(),
    argv: z.array(nonEmptyStringSchema).min(1).max(2),
  })
  .passthrough();
const typedToolOperationSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    description: nonEmptyStringSchema,
    effect: z.enum(["read", "change"]),
    argv: z.array(nonEmptyStringSchema).min(1),
    params: z.record(z.string(), typedToolParamSchema).optional(),
    required: z.array(nonEmptyStringSchema).optional(),
    exactlyOneOf: z.array(z.array(nonEmptyStringSchema).min(2)).optional(),
    confirm: z
      .union([
        z.literal("always"),
        z.object({ param: nonEmptyStringSchema, values: z.array(nonEmptyStringSchema).min(1) }),
      ])
      .optional(),
    confirmPreviewArgv: z.array(nonEmptyStringSchema).min(1).optional(),
  })
  .passthrough();
const typedToolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    description: nonEmptyStringSchema,
    script: nonEmptyStringSchema,
    operations: z.array(typedToolOperationSchema).min(1),
  })
  .passthrough();
const toolTemplateSchema = z
  .object({
    kind: z.literal("sovereign-tool-template"),
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    capabilities: z.array(nonEmptyStringSchema).min(1),
    requiredSecretRefs: z.array(nonEmptyStringSchema).default([]),
    requiredConfigKeys: z.array(nonEmptyStringSchema).default([]),
    allowedCommands: z.array(nonEmptyStringSchema).default([]),
    openclawPlugins: z.array(nonEmptyStringSchema).default([]),
    openclawBundledPlugins: z.array(nonEmptyStringSchema).default([]),
    openclawToolNames: z.array(nonEmptyStringSchema).default([]),
    openclawTypedTool: typedToolSchema.optional(),
    openclawScanAgent: z
      .object({ toolNames: z.array(nonEmptyStringSchema).min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();
const toolInstanceSchema = z
  .object({
    id: nonEmptyStringSchema,
    templateRef: nonEmptyStringSchema,
    enabledWhen: z
      .object({
        path: nonEmptyStringSchema,
        equals: finiteScalarSchema.optional(),
      })
      .passthrough()
      .optional(),
    config: bindingMapSchema.default({}),
    secretRefs: bindingMapSchema.default({}),
  })
  .passthrough();
const hostResourceSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: hostResourceKindSchema,
    spec: z.record(z.string(), z.unknown()),
  })
  .passthrough()
  .superRefine((resource, ctx) => {
    const has = (fieldName: string) => Object.hasOwn(resource.spec, fieldName);
    if (["directory", "managedFile", "stateFile"].includes(resource.kind) && !has("path")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spec", "path"],
        message: "must be defined",
      });
    }
    if (
      ["managedFile", "stateFile"].includes(resource.kind) &&
      !has("source") &&
      !has("inlineContent")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spec"],
        message: "must define source or inlineContent",
      });
    }
    for (const fieldName of resource.kind === "systemdService"
      ? ["name", "description", "execStart"]
      : resource.kind === "systemdTimer"
        ? ["name", "description"]
        : resource.kind === "openclawCron"
          ? ["id", "agentId", "desiredState"]
          : []) {
      if (!has(fieldName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spec", fieldName],
          message: "must be defined",
        });
      }
    }
    if (resource.kind === "openclawCron" && resource.spec.desiredState === "present") {
      for (const fieldName of ["every", "message"]) {
        if (!has(fieldName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["spec", fieldName],
            message: "must be defined when desiredState=present",
          });
        }
      }
    }
  });

export const manifestSchema = z
  .object({
    kind: manifestKindSchema,
    manifestVersion: finiteNumberSchema.refine((value) => value === 2, { message: "must be 2" }),
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    defaultInstall: z.boolean().optional(),
    helloMessage: nonEmptyStringSchema.optional(),
    matrixIdentity: z
      .object({
        mode: matrixIdentityModeSchema,
        localpartPrefix: nonEmptyStringSchema,
      })
      .passthrough(),
    matrixRouting: z
      .object({
        defaultAccount: z.boolean().optional(),
        // Which node room the bot lives in: "alert" (default, Sovereign
        // Alerts) or "operator" (the dedicated Sovereign Node control room).
        room: z.enum(["alert", "operator"]).optional(),
        dm: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
        alertRoom: z
          .object({
            autoReply: z.boolean().optional(),
            requireMention: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    configDefaults: z.record(z.string(), finiteScalarSchema).default({}),
    toolTemplates: z.array(toolTemplateSchema).default([]),
    toolInstances: z.array(toolInstanceSchema).default([]),
    hostResources: z.array(hostResourceSchema).default([]),
    agentTemplate: z
      .object({
        id: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        description: nonEmptyStringSchema,
        model: nonEmptyStringSchema.optional(),
        matrix: z
          .object({
            localpartPrefix: nonEmptyStringSchema,
          })
          .passthrough(),
        requiredToolTemplates: z.array(toolTemplateRefSchema).default([]),
        optionalToolTemplates: z.array(toolTemplateRefSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();
