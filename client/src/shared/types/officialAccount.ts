/** 本人可查询的历史个人来源；merged 表示已合并进当前账户的设备账户。 */
export interface OfficialAccountSource {
  sourceAccountId: string;
  merged: boolean;
}

/** 官方账户在页面上的展示状态，不包含开放令牌。 */
export interface OfficialAccountState {
  status: 'loading' | 'signed-out' | 'signed-in';
  clientId: string;
  identityType: 'anonymous' | 'email' | null;
  error: string;
  email: string | null;
  accountId: string | null;
  availablePoint: string | null;
  sources: OfficialAccountSource[];
}

export type OfficialEmailPurpose = 'LOGIN' | 'BIND';

export interface OfficialEmailCredentials {
  email: string;
  code: string;
}

/** 服务端页码分页结果。 */
export interface OfficialPage<T> {
  current: number;
  size: number;
  total: number;
  records: T[];
}

/** 订单和流水按来源分页查询；不传来源时查询当前账户或团队。 */
export interface OfficialPageQuery {
  current: number;
  sourceAccountId?: string;
}

/** 当前身份可查询的已结算消费；编号、点数保留服务端字符串精度。 */
export interface OfficialConsumeRecord {
  id: string;
  requestNo: string | null;
  aiType: 'TEXT_GENERATION' | 'REASONING' | 'IMAGE_GENERATION' | null;
  consumePoint: string;
  /** 历史来源结算到团队时服务端隐藏团队余额，为 null。 */
  availableAfter: string | null;
  createTime: string;
}

/** 充值套餐展示信息；金额（分）和点数保留服务端字符串精度。 */
export interface OfficialRechargeOption {
  id: string;
  name: string;
  payAmountFen: string;
  rechargePoint: string;
}

/** 服务端充值订单；二维码仅在创建响应或本机缓存中提供。 */
export interface OfficialRechargeOrder {
  orderNo: string;
  productName: string;
  payAmountFen: string;
  rechargePoint: string;
  status: 'WAITING' | 'PAID' | 'CLOSED';
  refundStatus: 'NONE' | 'PENDING' | 'SUCCESS' | 'FAILED';
  qrCode: string | null;
  createTime: string;
  paidTime: string | null;
}

/** 本地数据库保存的开票信息。 */
export interface OfficialInvoiceInfo {
  titleType: 'enterprise' | 'individual';
  buyer: string;
  taxNumber: string;
  email: string;
}

/** 单笔订单已有的开票申请。 */
export interface OfficialInvoiceApplication {
  status: 'PENDING' | 'REJECTED' | 'ISSUED';
  mailStatus: 'NOT_SENT' | 'SENT' | 'FAILED';
  rejectReason: string | null;
  version: number;
}

/** 提交单笔订单的开票申请；驳回后重新提交需带上申请的 version。 */
export interface OfficialInvoiceApplicationInput {
  orderNo: string;
  titleType: 'ENTERPRISE' | 'PERSONAL';
  invoiceTitle: string;
  taxpayerNo: string;
  receiverEmail: string;
  version?: number;
}
