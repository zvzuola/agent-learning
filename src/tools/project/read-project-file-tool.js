import { z } from 'zod';

/**
 * @param {{readTextFile(relativePath: string): Promise<string>}} projectReader
 * @returns {import('../tool-registry.js').ToolDefinition}
 */
export function createReadProjectFileTool(projectReader) {
  const schema = z.object({
    path: z.string().min(1),
  }).strict();

  return {
    name: 'read_project_file',
    description: 'Read a UTF-8 text file inside the current project. Use relative project paths only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'Project-relative file path, for example package.json or src/index.js',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    validate: (input) => schema.parse(input),
    policy: {
      timeoutMs: 2_000,
      maxResultBytes: 128 * 1024,
    },
    handler: async ({ path }) => ({
      path,
      content: await projectReader.readTextFile(path),
    }),
  };
}
