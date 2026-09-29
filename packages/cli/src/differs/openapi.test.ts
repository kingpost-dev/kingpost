import { describe, it, expect } from "vitest";
import { diffOpenApi } from "./openapi.js";

const withEndpoint = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const endpointRemoved = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
    },
  },
});

const endpointAdded = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/toys": {
      get: { operationId: "listToys", responses: { "200": { description: "ok" } } },
    },
  },
});

// openapi-diff does not diff bare query/path parameter definitions at all
// (confirmed empirically: flipping a query parameter from optional to
// required produces zero differences). It only compares request bodies (via
// json-schema-diff) and response headers. So "newly-required parameter" is
// exercised here via a request body field, which the library does detect.
const withOptionalBodyField = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      post: {
        operationId: "createPet",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const withNewlyRequiredBodyField = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      post: {
        operationId: "createPet",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, age: { type: "number" } },
                required: ["name", "age"],
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

describe("diffOpenApi", () => {
  it("flags a removed endpoint as breaking", async () => {
    const result = await diffOpenApi(withEndpoint, endpointRemoved);
    expect(result.breaking).toBe(true);
  });

  it("flags a newly-required request body field as breaking", async () => {
    const result = await diffOpenApi(withOptionalBodyField, withNewlyRequiredBodyField);
    expect(result.breaking).toBe(true);
  });

  it("does not flag an added optional endpoint as breaking", async () => {
    const result = await diffOpenApi(withEndpoint, endpointAdded);
    expect(result.breaking).toBe(false);
  });

  it("treats unparseable content as non-breaking", async () => {
    const result = await diffOpenApi(withEndpoint, "{not valid json");
    expect(result.breaking).toBe(false);
    expect(result.summary).toContain("unable to parse");
  });
});
