import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { extractPayerFromPaymentHeader } from "../middleware/rateLimit.js";

function mockRequest(headers: Record<string, string>): Request {
  return { headers } as Request;
}

describe("extractPayerFromPaymentHeader", () => {
  it("returns undefined when the header is missing", () => {
    expect(extractPayerFromPaymentHeader(mockRequest({}))).toBeUndefined();
  });

  it("extracts the payer address from a base64 x-payment payload", () => {
    const payload = {
      payload: {
        authorization: {
          address: "GABC123EXAMPLEADDRESS",
        },
      },
    };
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(
      extractPayerFromPaymentHeader(mockRequest({ "x-payment": header }))
    ).toBe("GABC123EXAMPLEADDRESS");
  });

  it("falls back to clientAddress when authorization is absent", () => {
    const payload = { clientAddress: "GCLIENT123EXAMPLEADDRESS" };
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(
      extractPayerFromPaymentHeader(mockRequest({ "x-payment": header }))
    ).toBe("GCLIENT123EXAMPLEADDRESS");
  });
});
