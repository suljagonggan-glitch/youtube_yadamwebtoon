export interface GeneratedImage {
  id: string;
  originalInput: string;
  refinedPrompt: string;
  suggestedPrompt?: string; // Analysis of failure and suggested fix
  sceneSummary?: string; // Short Korean summary of the specific scene
  imageUrl: string; // If failed, this can be a placeholder or empty
  timestamp: number;
  aspectRatio: string;
  batchId?: string; // To group images from the same story generation
  status: 'success' | 'failed'; // Track if generation worked
}

export interface GenerationConfig {
  aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
}

export type LoadingStatus = 'idle' | 'analyzing' | 'generating' | 'error' | 'success';

export interface LoadingState {
  status: LoadingStatus;
  current?: number; // Current scene number being generated
  total?: number;   // Total scenes to generate
  message?: string;
}