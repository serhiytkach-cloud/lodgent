import { readFileSync } from 'node:fs';
import { App, type Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { EnvName } from '../lib/config';
import { defineStacks, type EnvironmentStacks, type LodgentStacks } from '../lib/lodgent';

/** Feature flags and other context from cdk.json, so tests synthesize what `cdk synth` does. */
const cdkJsonContext = (
  JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

export interface Synthesized {
  stacks: LodgentStacks;
  /** The stacks of one environment (throws if it was not synthesized). */
  env(name: EnvName): EnvironmentStacks;
  template(stack: Stack): Template;
}

/** Defines every stack with the given extra context; templates are synthesized once per stack. */
export function synth(context: Record<string, unknown> = {}): Synthesized {
  const app = new App({ context: { ...cdkJsonContext, ...context } });
  const stacks = defineStacks(app);
  const cache = new Map<Stack, Template>();
  return {
    stacks,
    env(name) {
      const env = stacks.environments[name];
      if (!env) throw new Error(`environment ${name} was not synthesized`);
      return env;
    },
    template(stack) {
      let template = cache.get(stack);
      if (!template) {
        template = Template.fromStack(stack);
        cache.set(stack, template);
      }
      return template;
    },
  };
}

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };

/** All resources of a type, keyed by logical id. */
export function resources(template: Template, type: string): Record<string, Resource> {
  return template.findResources(type) as Record<string, Resource>;
}

export function only<T>(record: Record<string, T>): T {
  const values = Object.values(record);
  if (values.length !== 1) throw new Error(`expected exactly one resource, found ${values.length}`);
  return values[0]!;
}

export interface ContainerDefinition {
  Name: string;
  Image: unknown;
  Command?: string[];
  Essential?: boolean;
  Privileged?: boolean;
  ReadonlyRootFilesystem?: boolean;
  User?: string;
  Environment?: { Name: string; Value: unknown }[];
  Secrets?: { Name: string; ValueFrom: unknown }[];
  PortMappings?: { ContainerPort: number }[];
  DependsOn?: { ContainerName: string; Condition: string }[];
  LinuxParameters?: { Capabilities?: { Add?: string[] } };
}

export function containers(template: Template): ContainerDefinition[] {
  return Object.values(resources(template, 'AWS::ECS::TaskDefinition')).flatMap(
    (task) => task.Properties.ContainerDefinitions as ContainerDefinition[],
  );
}

export function container(template: Template, name: string): ContainerDefinition {
  const found = containers(template).filter((c) => c.Name === name);
  if (found.length !== 1) throw new Error(`expected one container named ${name}, found ${found.length}`);
  return found[0]!;
}

export function environment(c: ContainerDefinition): Record<string, unknown> {
  return Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
}

/** Resolves the policy statements attached (inline policies) to the role with the given logical id. */
export function statementsForRole(template: Template, roleLogicalId: string): Record<string, unknown>[] {
  return Object.values(resources(template, 'AWS::IAM::Policy'))
    .filter((policy) =>
      (policy.Properties.Roles as unknown[]).some((role) =>
        JSON.stringify(role).includes(`"${roleLogicalId}"`),
      ),
    )
    .flatMap(
      (policy) => (policy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
}

export function actionsOf(statements: Record<string, unknown>[]): string[] {
  return statements.flatMap((s) => (Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string]));
}
