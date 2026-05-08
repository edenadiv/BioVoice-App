export type Decision = "ACCEPT" | "REJECT" | "DEEPFAKE" | "PENDING";

export type VerificationResult = {
  resultId: string;
  userId: string;
  decision: Decision;
  similarityScore: number;
  deepfakeScore: number;
  centroidSimilarity: number;
  sampleSimilarities: number[];
  message: string;
  createdAt: string;
};

export type Speaker = {
  userId: string;
  sampleCount: number;
  enrolledAt: string;
};

export type Session = {
  sessionToken: string;
  userId: string;
  createdAt: string;
};

export type ReferenceSample = {
  sampleId: string;
  userId: string;
  originalFilename: string;
  source: string;
  createdAt: string;
};

export type SpoofGenerationResult = {
  audioUrl: string;
  fileName: string;
  sourceDescription: string;
  text: string;
  language: string;
};
