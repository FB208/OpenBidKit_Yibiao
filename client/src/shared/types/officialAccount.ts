/** 官方账户在页面上的展示状态，不包含开放令牌。 */
export interface OfficialAccountState {
  status: 'loading' | 'signed-out' | 'signed-in';
  clientId: string;
  identityType: 'anonymous' | 'email' | null;
  error: string;
  email: string | null;
  accountId: string | null;
  availablePoint: string | null;
}

export type OfficialEmailPurpose = 'LOGIN' | 'BIND';

export interface OfficialEmailCredentials {
  email: string;
  code: string;
}

/** 当前身份可查询的已结算消费；编号、点数保留服务端字符串精度。 */
export interface OfficialConsumeRecord {
  recordId: string;
  requestNo: string | null;
  consumeType: 'AI_SETTLE';
  consumePoint: string;
  availableAfter: string;
  remark: string | null;
  consumeTime: string;
}

/** 匿名和邮箱身份共用消费记录分页结构。 */
export interface OfficialTransactionsPage {
  current: number;
  size: number;
  total: number;
  records: OfficialConsumeRecord[];
}

/** 充值商品展示信息；价格和点数保留服务端字符串精度。 */
export interface OfficialRechargeOption {
  id: string;
  name: string;
  price: string;
  pointValue: string;
}

/** 服务端充值订单；二维码仅在创建响应中返回。 */
export interface OfficialRechargeOrder {
  id: string;
  orderNo: string;
  optionId: string;
  optionName: string;
  quantity: number;
  payPrice: string;
  totalPoint: string;
  payStatus: 'WAITING' | 'SUCCESS' | 'CLOSED';
  refundStatus: 'NONE' | 'PENDING' | 'SUCCESS' | 'FAILED';
  invoiceStatus: 'CLOSED' | 'CAN_APPLY' | 'PENDING' | 'REJECTED' | 'ISSUED';
  qrCode: string | null;
  createTime: string;
  finishTime: string | null;
}

/** 本地数据库保存的开票信息。 */
export interface OfficialInvoiceInfo {
  titleType: 'enterprise' | 'individual';
  buyer: string;
  taxNumber: string;
  email: string;
}

/** 提交单笔订单的开票申请。 */
export interface OfficialInvoiceApplicationInput {
  rechargeOrderId: string;
  titleType: 'ENTERPRISE' | 'PERSONAL';
  invoiceTitle: string;
  taxpayerNo: string;
  receiverEmail: string;
  remark: string;
}
