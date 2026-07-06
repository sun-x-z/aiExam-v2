import { IMPORT_FIELDS, type ImportField } from "@/lib/types";

export { IMPORT_FIELDS };

export const FIELD_LABELS: Record<ImportField, string> = {
  externalCode: "外部编码",
  storeName: "收货门店",
  recipientName: "收件人姓名",
  recipientPhone: "收件人电话",
  recipientAddress: "收件人地址",
  skuCode: "SKU物品编码",
  skuName: "SKU物品名称",
  skuQuantity: "SKU发货数量",
  skuSpec: "SKU规格型号",
  note: "备注",
};

export const REQUIRED_SKU_FIELDS: ImportField[] = ["skuCode", "skuName", "skuQuantity"];

export const FIELD_ALIASES: Record<ImportField, string[]> = {
  externalCode: ["外部编码", "外部订单号", "配送单号", "单据号", "订单号", "客户单号", "Ref", "Order No"],
  storeName: ["收货门店", "收货机构", "订货机构", "门店", "门店名称", "店铺", "机构名称"],
  recipientName: ["收件人姓名", "收件人", "收货人", "联系人", "客户姓名", "Receiver", "Recipient"],
  recipientPhone: ["收件人电话", "收货电话", "联系电话", "手机号", "手机", "电话", "Receiver Phone"],
  recipientAddress: ["收件人地址", "收货地址", "地址", "详细地址", "Receiver Address"],
  skuCode: ["SKU物品编码", "SKU编码", "物品编码", "商品编码", "外部商品编码", "SKU条码", "条码", "编码"],
  skuName: ["SKU物品名称", "SKU名称", "物品名称", "商品名称", "品名", "名称"],
  skuQuantity: ["SKU发货数量", "发货数量", "数量", "订货数量", "接单数量", "实际数量", "Qty", "Quantity"],
  skuSpec: ["SKU规格型号", "规格型号", "规格", "型号", "单位规格", "Spec"],
  note: ["备注", "附言", "说明", "收货机构备注", "Note", "Remarks"],
};

export const EMPTY_IMPORT_VALUES: Record<ImportField, string> = Object.fromEntries(
  IMPORT_FIELDS.map((field) => [field, ""])
) as Record<ImportField, string>;
