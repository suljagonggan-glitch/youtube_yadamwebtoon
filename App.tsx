import React, { useState, useEffect } from 'react';
import { analyzeScript, generateImage, downloadImage, getPromptFix, hasApiKey, getApiKey } from './services/geminiService';
import { GeneratedImage, LoadingState } from './types';
import { ASPECT_RATIOS } from './constants';
import Button from './components/Button';
import HistoryItem from './components/HistoryItem';

const App: React.FC = () => {
  const [inputText, setInputText] = useState('');
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "1:1" | "9:16">("16:9");
  const [isApiKeyMissing, setIsApiKeyMissing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  // Loading State
  const [loadingState, setLoadingState] = useState<LoadingState>({ status: 'idle' });
  
  // Display list
  const [currentBatch, setCurrentBatch] = useState<GeneratedImage[]>([]);
  
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Track retrying items
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Check for API key on mount
    if (!hasApiKey()) {
        setIsApiKeyMissing(true);
    }

    const saved = localStorage.getItem('yadam-history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('yadam-history', JSON.stringify(history));
  }, [history]);

  const handleGenerate = async () => {
    if (!inputText.trim()) return;

    setLoadingState({ status: 'analyzing', message: '이야기를 분석하고 장면을 나누고 있습니다...' });
    setErrorMsg(null);
    
    // NOTE: We do NOT clear currentBatch immediately so the user can see old images 
    // while the script is being analyzed. We only clear it right before the first new image arrives.

    const batchId = Date.now().toString();
    const tempBatch: GeneratedImage[] = [];

    try {
      // Step 1: Analyze Script
      const scenes = await analyzeScript(inputText);
      
      setLoadingState({ 
        status: 'generating', 
        current: 0, 
        total: scenes.length,
        message: `총 ${scenes.length}개의 장면을 생성할 준비가 되었습니다.`
      });

      // Clear previous batch now that we are about to start generating new ones
      setCurrentBatch([]);

      // Step 2: Loop Generate
      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        
        // Add a delay between requests to avoid Rate Limits (429 errors)
        // Especially important for free/tier keys with Flash model
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
        }
        
        setLoadingState({ 
          status: 'generating', 
          current: i + 1, 
          total: scenes.length,
          message: `장면 ${i + 1} / ${scenes.length} 그리는 중... (${scene.korean_summary})` 
        });

        try {
          const imageUrl = await generateImage(scene.english_prompt, aspectRatio);
          
          const newImage: GeneratedImage = {
            id: `${batchId}_${i}`,
            batchId: batchId,
            originalInput: inputText,
            refinedPrompt: scene.english_prompt,
            sceneSummary: scene.korean_summary,
            imageUrl: imageUrl,
            timestamp: Date.now(),
            aspectRatio: aspectRatio,
            status: 'success'
          };

          tempBatch.push(newImage);
          setCurrentBatch([...tempBatch]);
          setHistory(prev => [newImage, ...prev]);

        } catch (imgError) {
          console.error(`Failed to generate scene ${i+1}`, imgError);
          
          // Try to get a fix suggestion
          let suggestedPrompt: string | undefined;
          try {
             suggestedPrompt = await getPromptFix(scene.english_prompt);
          } catch (fixErr) {
             console.error("Could not generate prompt fix", fixErr);
          }

          const failedImage: GeneratedImage = {
            id: `${batchId}_${i}`,
            batchId: batchId,
            originalInput: inputText,
            refinedPrompt: scene.english_prompt,
            suggestedPrompt: (suggestedPrompt && suggestedPrompt !== scene.english_prompt) ? suggestedPrompt : undefined,
            sceneSummary: scene.korean_summary,
            imageUrl: '', 
            timestamp: Date.now(),
            aspectRatio: aspectRatio,
            status: 'failed'
          };
          
          tempBatch.push(failedImage);
          setCurrentBatch([...tempBatch]);
        }
      }
      
      setLoadingState({ status: 'success' });
      
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "알 수 없는 오류가 발생했습니다.");
      setLoadingState({ status: 'error' });
    }
  };
  
  const handleRetry = async (item: GeneratedImage, useSuggestion: boolean = false) => {
    if (retryingIds.has(item.id)) return;

    setRetryingIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    
    try {
      const promptToUse = useSuggestion && item.suggestedPrompt ? item.suggestedPrompt : item.refinedPrompt;
      const imageUrl = await generateImage(promptToUse, item.aspectRatio as any);
      
      const successItem: GeneratedImage = {
        ...item,
        imageUrl,
        refinedPrompt: promptToUse, // Update to the prompt used
        status: 'success',
        timestamp: Date.now()
      };

      setCurrentBatch(prev => prev.map(img => {
        if (img.id === item.id) {
          return successItem;
        }
        return img;
      }));

      setHistory(prev => [successItem, ...prev]);

    } catch (e) {
      console.error("Retry failed", e);
      setErrorMsg("재시도에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setRetryingIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleDelete = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
    setCurrentBatch(prev => prev.filter(item => item.id !== id));
  };

  const handleDownload = (img: GeneratedImage) => {
    if (img.status === 'success') {
        const filename = `yadam_${img.id}.png`;
        downloadImage(img.imageUrl, filename);
    }
  };

  const handleSelectHistoryItem = (item: GeneratedImage) => {
    setCurrentBatch([item]);
    if (item.batchId) {
        const siblings = history.filter(h => h.batchId === item.batchId).reverse();
        if (siblings.length > 1) {
             const sortedSiblings = siblings.sort((a, b) => a.id.localeCompare(b.id));
             setCurrentBatch(sortedSiblings);
             return;
        }
    }
    setCurrentBatch([item]);
  };

  if (isApiKeyMissing) {
      return (
          <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
              <div className="bg-white p-8 rounded-xl shadow-xl max-w-lg w-full border border-slate-200">
                  <div className="flex items-center gap-3 mb-4 text-amber-500">
                      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                      <h2 className="text-xl font-bold text-slate-800">API Key 설정 필요</h2>
                  </div>
                  <p className="text-slate-600 mb-6 leading-relaxed">
                      야담 메이커를 실행하려면 <strong>Google Gemini API Key</strong>가 필요합니다.<br/>
                      프로젝트 폴더의 <code className="bg-slate-100 px-2 py-1 rounded">.env.local</code> 파일에 API 키를 설정해주세요.
                  </p>
                  
                  <div className="bg-slate-800 rounded-lg p-4 mb-6 text-slate-200 text-sm font-mono overflow-x-auto">
                      <p className="mb-2 text-slate-400"># 프로젝트 폴더의 .env.local 파일을 열어 아래와 같이 수정하세요.</p>
                      <p className="text-emerald-400">VITE_GEMINI_API_KEY=AIzaSy...</p>
                  </div>
                  
                  <div className="text-sm text-slate-500 border-t border-slate-100 pt-4">
                      <p>1. <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline font-bold">Google AI Studio</a>에서 키를 발급받으세요.</p>
                      <p className="mt-1">2. <code>.env.local</code> 파일의 <code>YOUR_ACTUAL_API_KEY_HERE</code>를 실제 키로 교체하세요.</p>
                      <p className="mt-1">3. 파일을 저장한 후 개발 서버를 재시작해주세요.</p>
                      <p className="mt-2 text-amber-600 font-semibold">⚠️ Vercel 등 배포 환경에서는 환경 변수를 별도로 설정해야 합니다.</p>
                  </div>
              </div>
          </div>
      );
  }

  const isLoading = loadingState.status === 'analyzing' || loadingState.status === 'generating';

  const maskApiKey = (key: string): string => {
    if (key.length <= 8) return '***';
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
  };

  return (
    <>
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-slate-800">설정</h2>
              <button 
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">
                  Google Gemini API Key
                </label>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <p className="font-mono text-sm text-slate-600 break-all">
                    {getApiKey() ? maskApiKey(getApiKey()!) : '설정되지 않음'}
                  </p>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  보안을 위해 일부만 표시됩니다. .env.local 파일에서 수정하세요.
                </p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                  <div className="text-sm text-blue-800">
                    <p className="font-bold mb-1">API 키 변경 방법</p>
                    <ol className="list-decimal list-inside space-y-1 text-xs">
                      <li>프로젝트 폴더의 <code className="bg-white px-1 rounded">.env.local</code> 파일을 수정하세요.</li>
                      <li><code className="bg-white px-1 rounded">VITE_GEMINI_API_KEY=새로운키</code> 형식으로 입력하세요.</li>
                      <li>개발 서버를 재시작하세요.</li>
                    </ol>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-200">
                <a 
                  href="https://aistudio.google.com/app/apikey" 
                  target="_blank" 
                  rel="noreferrer"
                  className="text-sm text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1 hover:underline"
                >
                  Google AI Studio에서 API 키 발급받기
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Left Panel */}
      <div className="w-full md:w-[400px] bg-white border-r border-slate-200 p-6 flex flex-col shrink-0 h-auto md:h-screen md:overflow-y-auto sticky top-0 z-10">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="bg-indigo-600 text-white p-2 rounded-lg">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
              </span>
              <h1 className="text-2xl font-black text-slate-800 tracking-tight">야담 <span className="font-light text-slate-500 text-lg">메이커</span></h1>
            </div>
            <button 
              onClick={() => setShowSettings(true)}
              className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-colors"
              title="설정"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            </button>
          </div>
          <p className="text-sm text-slate-500">대본만 넣으면 웹툰 한 편이 뚝딱.</p>
        </div>

        <div className="space-y-6 flex-1">
          <div>
            <label className="block text-sm font-bold text-slate-700 mb-2">
              이야기 대본
            </label>
            <textarea
              className="w-full h-48 p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-none text-slate-800 placeholder-slate-400 bg-slate-50"
              placeholder="전체 이야기를 입력하세요..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isLoading}
            />
            <p className="text-xs text-slate-400 mt-1 text-right">{inputText.length}자</p>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 mb-2">이미지 비율</label>
            <div className="grid grid-cols-3 gap-2">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio.value}
                  onClick={() => setAspectRatio(ratio.value as any)}
                  className={`py-2 px-1 text-xs sm:text-sm border rounded-md transition-all ${
                    aspectRatio === ratio.value
                      ? 'bg-indigo-50 border-indigo-500 text-indigo-700 font-bold'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {ratio.label}
                </button>
              ))}
            </div>
          </div>

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm flex items-start gap-2">
               <span className="shrink-0 mt-0.5">⚠️</span>
               {errorMsg}
            </div>
          )}

          <Button 
            className="w-full text-lg" 
            onClick={handleGenerate} 
            isLoading={isLoading}
            disabled={!inputText.trim()}
          >
            {isLoading ? (
               <div className="flex flex-col items-center">
                   <span>{loadingState.message || '작업 중...'}</span>
                   {loadingState.total && loadingState.current !== undefined && (
                       <span className="text-xs opacity-80 font-normal mt-1">
                           ({loadingState.current} / {loadingState.total} 완료)
                       </span>
                   )}
               </div>
            ) : '스토리 이미지 생성하기'}
          </Button>
          
          <div className="pt-6 border-t border-slate-100">
             <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">최근 성공작</h3>
             <div className="space-y-3">
               {history.length === 0 ? (
                 <p className="text-sm text-slate-400 text-center py-4">아직 생성된 이미지가 없습니다.</p>
               ) : (
                 history.slice(0, 5).map((item) => (
                   <div 
                      key={item.id} 
                      onClick={() => handleSelectHistoryItem(item)}
                      className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors border border-transparent hover:border-slate-200"
                    >
                      <img src={item.imageUrl} alt="" className="w-12 h-12 rounded object-cover bg-slate-200" />
                      <div className="flex-1 min-w-0">
                         <p className="text-sm text-slate-800 font-medium truncate">
                             {item.sceneSummary || item.originalInput}
                         </p>
                         <p className="text-xs text-slate-400">{new Date(item.timestamp).toLocaleTimeString()}</p>
                      </div>
                   </div>
                 ))
               )}
             </div>
          </div>
        </div>
      </div>

      {/* Right Panel */}
      <div className="flex-1 bg-slate-50 p-4 md:p-8 overflow-y-auto h-auto md:h-screen">
        <div className="max-w-4xl mx-auto h-full flex flex-col">
          
          {currentBatch.length > 0 ? (
            <div className="space-y-8 pb-12">
              <div className="flex items-center justify-between">
                  <h2 className="text-xl font-bold text-slate-800">
                      스토리 보드 
                      <span className="ml-2 text-sm font-normal text-slate-500 bg-white px-2 py-1 rounded-full border border-slate-200">
                          {currentBatch.length}개 장면
                      </span>
                  </h2>
              </div>

              {currentBatch.map((img, idx) => (
                  <div key={img.id} className={`rounded-xl shadow-lg overflow-hidden border ${img.status === 'failed' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center justify-between px-6 py-3 border-b border-slate-100 bg-white/50">
                        <div className="flex items-center gap-2">
                            <span className={`text-white text-xs font-bold px-2 py-1 rounded ${img.status === 'failed' ? 'bg-red-500' : 'bg-slate-800'}`}>
                                #{idx + 1}
                            </span>
                            <span className="text-sm font-bold text-slate-700">{img.sceneSummary || "장면 내용"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            {img.status === 'success' && (
                                <Button variant="secondary" onClick={() => handleDownload(img)} className="!py-1.5 !px-3 !text-xs">
                                    저장
                                </Button>
                            )}
                            <button 
                                onClick={() => handleDelete(img.id)}
                                className="text-slate-400 hover:text-red-500 p-1.5 rounded-md hover:bg-slate-100 transition-colors"
                                title="삭제/닫기"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    {/* Image Area */}
                    <div className={`relative flex items-center justify-center p-4 min-h-[300px] ${img.status === 'failed' ? 'bg-red-50' : "bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-slate-100"}`}>
                      {img.status === 'success' ? (
                          <img 
                            src={img.imageUrl} 
                            alt={img.sceneSummary} 
                            className="max-w-full rounded shadow-sm object-contain max-h-[600px]"
                          />
                      ) : (
                          <div className="text-center text-red-400 flex flex-col items-center max-w-lg p-6 bg-white rounded-lg shadow-sm border border-red-100">
                              <div className="flex items-center gap-3 mb-3 text-red-500">
                                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                                <span className="font-bold text-lg">이미지 생성 실패</span>
                              </div>
                              <p className="text-slate-600 mb-4 text-sm leading-relaxed">
                                  죄송합니다, 이 장면을 생성하지 못했습니다.
                              </p>

                              {img.suggestedPrompt && (
                                <div className="mb-4 bg-indigo-50 p-3 rounded text-sm text-indigo-900 border border-indigo-100 text-left w-full">
                                   <div className="flex items-start gap-2 mb-2">
                                     <span className="text-lg">💡</span>
                                     <div>
                                       <p className="font-bold">AI 제안:</p>
                                       <p className="text-xs opacity-80">안전 정책을 통과하도록 프롬프트를 수정했습니다.</p>
                                     </div>
                                   </div>
                                   <p className="font-mono text-xs bg-white p-2 rounded border border-indigo-100 text-slate-600 mb-3 break-words">
                                     {img.suggestedPrompt}
                                   </p>
                                   <Button 
                                      variant="primary"
                                      className="w-full text-xs py-2 bg-indigo-600 hover:bg-indigo-700 shadow-none"
                                      onClick={() => handleRetry(img, true)}
                                      isLoading={retryingIds.has(img.id)}
                                   >
                                      수정된 프롬프트로 재시도
                                   </Button>
                                </div>
                              )}

                              <div className="flex gap-2 w-full">
                                <Button 
                                    variant="secondary" 
                                    onClick={() => handleRetry(img, false)}
                                    isLoading={retryingIds.has(img.id)}
                                    className="flex-1 border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-indigo-600"
                                >
                                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                    원본으로 다시 시도
                                </Button>
                              </div>
                          </div>
                      )}
                    </div>
    
                    <div className="p-4 bg-slate-50/50 border-t border-slate-200">
                        <details className="text-xs">
                            <summary className="cursor-pointer text-slate-500 font-medium hover:text-indigo-600">프롬프트 상세 보기 (English)</summary>
                            <div className="mt-2">
                                <p className="mb-1 text-slate-400 font-bold">원본 요청 (English Prompt):</p>
                                <p className="text-slate-500 font-mono bg-white p-2 rounded border border-slate-200 break-words leading-relaxed">
                                    {img.originalInput !== img.refinedPrompt ? img.refinedPrompt : img.originalInput}
                                </p>
                            </div>
                        </details>
                    </div>
                  </div>
              ))}
              
              {isLoading && (
                   <div className="bg-white rounded-xl shadow border border-slate-200 p-8 flex flex-col items-center justify-center text-slate-400 animate-pulse">
                        <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-indigo-500 border-t-transparent mb-2"></div>
                        <p>다음 장면 생성 중... (잠시 대기 중)</p>
                   </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 min-h-[50vh] border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
               {isLoading ? (
                   <div className="text-center max-w-sm">
                       <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-indigo-500 border-t-transparent mb-6"></div>
                       <h3 className="text-xl font-bold text-slate-700 mb-2">
                           {loadingState.status === 'analyzing' ? '대본 분석 중' : '이미지 생성 중'}
                       </h3>
                       <p className="text-slate-500">
                         {loadingState.message}
                       </p>
                       {loadingState.total && loadingState.current !== undefined && (
                           <div className="w-full bg-slate-200 rounded-full h-2.5 mt-4">
                               <div 
                                    className="bg-indigo-600 h-2.5 rounded-full transition-all duration-500" 
                                    style={{ width: `${(loadingState.current / loadingState.total) * 100}%` }}
                               ></div>
                           </div>
                       )}
                   </div>
               ) : (
                  <>
                    <svg className="w-16 h-16 mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                    <p className="text-lg font-medium mb-1">나만의 야담 웹툰 만들기</p>
                    <p className="text-sm text-slate-400 text-center max-w-md">
                        긴 이야기를 입력하면 AI가 자동으로 장면을 나누어<br/>
                        여러 장의 이미지를 순서대로 그려줍니다.
                    </p>
                  </>
               )}
            </div>
          )}
          
          {!isLoading && history.length > 0 && currentBatch.length === 0 && (
            <div className="mt-12">
               <h2 className="text-xl font-bold text-slate-800 mb-4">전체 갤러리</h2>
               <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {history.map((item) => (
                    <HistoryItem 
                        key={item.id} 
                        item={item} 
                        onSelect={handleSelectHistoryItem} 
                        onDelete={handleDelete} 
                    />
                  ))}
               </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
};

export default App;