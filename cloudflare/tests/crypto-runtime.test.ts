import { describe, expect, it } from "vitest";
import { constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, publicEncrypt } from "node:crypto";
import { Buffer } from "node:buffer";

describe("workerd crypto compatibility", () => {
  it("supports AES-CBC and MD5", () => {
    expect(createHash("md5").update("abc").digest("hex")).toBe("900150983cd24fb0d6963f7d28e17f72");
    const c = createCipheriv("aes-128-cbc", Buffer.alloc(16), Buffer.alloc(16));
    const encrypted = Buffer.concat([c.update(Buffer.from("hello")), c.final()]);
    const d = createDecipheriv("aes-128-cbc", Buffer.alloc(16), Buffer.alloc(16));
    expect(Buffer.concat([d.update(encrypted), d.final()]).toString()).toBe("hello");
  });
  it("supports DES-equivalent repeated-key 3DES", () => {
    const key = Buffer.from("123456781234567812345678");
    const c = createCipheriv("des-ede3-cbc", key, Buffer.alloc(8));
    const encrypted = Buffer.concat([c.update(Buffer.from("hello")), c.final()]);
    const d = createDecipheriv("des-ede3-cbc", key, Buffer.alloc(8));
    expect(Buffer.concat([d.update(encrypted), d.final()]).toString()).toBe("hello");
  });
  it("supports RSA PKCS1 v1.5 encryption and decryption", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const enc = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from("hello"));
    expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, enc).toString()).toBe("hello");
  });
});
