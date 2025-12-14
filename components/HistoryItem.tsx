import React from 'react';
import { GeneratedImage } from '../types';

interface HistoryItemProps {
  item: GeneratedImage;
  onSelect: (item: GeneratedImage) => void;
  onDelete: (id: string) => void;
}

const HistoryItem: React.FC<HistoryItemProps> = ({ item, onSelect, onDelete }) => {
  return (
    <div className="group relative bg-white border border-slate-200 rounded-lg overflow-hidden hover:shadow-md transition-shadow">
      <div 
        className="aspect-square w-full cursor-pointer overflow-hidden bg-slate-100"
        onClick={() => onSelect(item)}
      >
        <img 
          src={item.imageUrl} 
          alt={item.originalInput} 
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
        />
      </div>
      <div className="p-3">
        <p className="text-sm text-slate-700 line-clamp-2 font-medium mb-2">{item.originalInput}</p>
        <div className="flex justify-between items-center">
            <span className="text-xs text-slate-400">
                {new Date(item.timestamp).toLocaleDateString()}
            </span>
            <button 
                onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
                className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
            >
                삭제
            </button>
        </div>
      </div>
    </div>
  );
};

export default HistoryItem;