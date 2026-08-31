export type CredentialOwnerType = 'profile' | 'certificate' | 'employee' | 'project' | 'other';

export type CredentialImageFieldKey =
  | 'officeEnvironment'
  | 'businessLicense'
  | 'legalRepresentativeIdEmblem'
  | 'legalRepresentativeIdPortrait'
  | 'legalRepresentativeAuthorization'
  | 'authorizedRepresentativeIdEmblem'
  | 'authorizedRepresentativeIdPortrait'
  | 'basicDepositAccountInfo'
  | 'creditChinaReport'
  | 'governmentProcurementRecord'
  | 'enterpriseCreditReport'
  | 'dishonestEnforcementQuery'
  | 'certificateImages'
  | 'employeeSocialSecurity'
  | 'employeeIdEmblem'
  | 'employeeIdPortrait'
  | 'laborContract'
  | 'educationCertificate'
  | 'driverLicense'
  | 'skillCertificate'
  | 'projectContract'
  | 'bidWinningNotice'
  | 'projectAcceptanceCertificate'
  | 'paymentInvoice'
  | 'taxCertificate'
  | 'auditReport'
  | 'socialSecurityCertificate'
  | 'bankAccountLicense'
  | 'otherMaterialImages';

export interface CredentialLibraryProfile {
  companyName: string;
  unifiedSocialCreditCode: string;
  phone: string;
  email: string;
  legalRepresentative: string;
  registeredCapital: string;
  operatingPeriodStart: string;
  operatingPeriodEnd: string;
  address: string;
  businessScope: string;
  industry: string;
  companyType: string;
  insuredEmployeeCount: string;
  companyIntro: string;
  taxCertificateDate: string;
  taxCertificateNote: string;
  auditReportDate: string;
  auditReportNote: string;
  socialSecurityCertificateDate: string;
  socialSecurityCertificateNote: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankName: string;
  bankRoutingNumber: string;
  watermarkEnabled: boolean;
  watermarkContent: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialCertificate {
  certificateId: string;
  name: string;
  number: string;
  validityMode: '' | 'range' | 'long-term';
  validFrom: string;
  validTo: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialEmployee {
  employeeId: string;
  name: string;
  idNumber: string;
  position: string;
  professionalTitle: string;
  gender: string;
  phone: string;
  idValidityMode: '' | 'range' | 'long-term';
  idValidFrom: string;
  idValidTo: string;
  education: string;
  school: string;
  major: string;
  introduction: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialProject {
  projectId: string;
  projectName: string;
  projectNumber: string;
  customerName: string;
  projectType: '' | 'service' | 'goods' | 'construction';
  projectManager: string;
  contractAmount: string;
  startDate: string;
  endDate: string;
  projectStatus: string;
  introduction: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialOtherMaterial {
  materialId: string;
  name: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialImage {
  imageId: string;
  ownerType: CredentialOwnerType;
  ownerId: string;
  fieldKey: CredentialImageFieldKey;
  originalName: string;
  relativePath: string;
  assetUrl: string;
  customName: string;
  sortOrder: number;
  createdAt: string;
}

export interface CredentialLibrarySnapshot {
  profile: CredentialLibraryProfile;
  certificates: CredentialCertificate[];
  employees: CredentialEmployee[];
  projects: CredentialProject[];
  otherMaterials: CredentialOtherMaterial[];
  images: CredentialImage[];
}

export interface CredentialLibraryMutationResult {
  snapshot: CredentialLibrarySnapshot;
  fileDeleteFailures: string[];
}

export interface CredentialLibraryImportResult extends CredentialLibraryMutationResult {
  counts: {
    certificates: number;
    employees: number;
    projects: number;
    otherMaterials: number;
    images: number;
  };
}

export interface CredentialNewImage {
  fieldKey: CredentialImageFieldKey;
  filePath: string;
  customName?: string;
}

export interface CredentialRecordSavePayload<TRecord> {
  record: TRecord;
  newImages?: CredentialNewImage[];
  removedImageIds?: string[];
  imageNameUpdates?: Array<{ imageId: string; customName: string }>;
}

export type CredentialRecord = CredentialCertificate | CredentialEmployee | CredentialProject | CredentialOtherMaterial;

export const emptyCredentialProfile: CredentialLibraryProfile = {
  companyName: '',
  unifiedSocialCreditCode: '',
  phone: '',
  email: '',
  legalRepresentative: '',
  registeredCapital: '',
  operatingPeriodStart: '',
  operatingPeriodEnd: '',
  address: '',
  businessScope: '',
  industry: '',
  companyType: '',
  insuredEmployeeCount: '',
  companyIntro: '',
  taxCertificateDate: '',
  taxCertificateNote: '',
  auditReportDate: '',
  auditReportNote: '',
  socialSecurityCertificateDate: '',
  socialSecurityCertificateNote: '',
  bankAccountName: '',
  bankAccountNumber: '',
  bankName: '',
  bankRoutingNumber: '',
  watermarkEnabled: false,
  watermarkContent: '',
  createdAt: '',
  updatedAt: '',
};
