import { describe,expect,it } from "vitest";
import original from "./fixtures/original-rules.json";
import { buildForm,selectTask,paths } from "../src/engine/sign";
import { pythonStr, signedBody, aes, md5 } from "../src/engine/crypto";
import { classify } from "../src/notify";
import type { Account,Result } from "../src/types";

describe("actual original Python rule parity (synthetic fixtures)",()=>{
  for(const test of original.apis)it(`preserves original task API paths: ${test.type}`,()=>{
    const api=paths(test.type as 1|2);expect([api.list,api.detail,api.submit]).toEqual(test.paths);
  });
  it("produces exactly the original extra-field form",()=>{
    expect(buildForm(original.form.user as Account,original.form.task)).toEqual(original.form.expected);
  });
  for(const [index,test] of original.selection.entries())it(`selects the same original task (${index})`,()=>{
    const selected=selectTask(test.list,test.user as Account,"submit");
    expect({signInstanceWid:selected.signInstanceWid,signWid:selected.signWid}).toEqual(test.expected);
  });
  for(const [index,test] of original.pythonStrings.entries())it(`matches Python str for signature material (${index})`,()=>{
    expect(pythonStr(test.input)).toBe(test.expected);
  });
  for(const [index,test] of original.signatureMaterial.entries())it(`matches Python float serialization and signature inputs (${index})`,()=>{
    const key="1234567890123456";
    const body=aes(test.serialized,key);
    expect(signedBody(test.form,key)).toEqual({bodyString:body,sign:md5(test.sortedValues+body+key)});
  });
  for(const test of original.classification)it(`matches original result classification: ${test.input.status}`,()=>{
    expect(classify(test.input as Result)).toBe(test.expected);
  });
});
