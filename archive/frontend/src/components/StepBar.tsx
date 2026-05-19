/**
 * 步骤导航条组件
 */
import React from 'react';
import { CheckIcon } from '@heroicons/react/24/solid';

interface StepBarProps {
  steps: string[];
  currentStep: number;
}

const StepBar: React.FC<StepBarProps> = ({ steps, currentStep }) => {
  return (
    <div className="w-full py-6">
      <nav aria-label="Progress">
        <ol className="flex items-center">
          {steps.map((step, index) => (
            <li key={step} className={`relative ${index !== steps.length - 1 ? 'pr-8 sm:pr-20' : ''} flex-1`}>
              {index < currentStep ? (
                <>
                  <div className="absolute inset-0 flex items-center" aria-hidden="true">
                    <div className="h-0.5 w-full bg-primary-600" />
                  </div>
                  <div className="relative w-8 h-8 flex items-center justify-center bg-primary-600 rounded-full hover:bg-primary-900">
                    <CheckIcon className="w-5 h-5 text-white" aria-hidden="true" />
                    <span className="sr-only">{step}</span>
                  </div>
                </>
              ) : index === currentStep ? (
                <>
                  <div className="absolute inset-0 flex items-center" aria-hidden="true">
                    <div className="h-0.5 w-full bg-gray-200" />
                  </div>
                  <div className="relative w-8 h-8 flex items-center justify-center bg-white border-2 border-primary-600 rounded-full" aria-current="step">
                    <span className="h-2.5 w-2.5 bg-primary-600 rounded-full" aria-hidden="true" />
                    <span className="sr-only">{step}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="absolute inset-0 flex items-center" aria-hidden="true">
                    <div className="h-0.5 w-full bg-gray-200" />
                  </div>
                  <div className="group relative w-8 h-8 flex items-center justify-center bg-white border-2 border-gray-300 rounded-full hover:border-gray-400">
                    <span className="h-2.5 w-2.5 bg-transparent rounded-full group-hover:bg-gray-300" aria-hidden="true" />
                    <span className="sr-only">{step}</span>
                  </div>
                </>
              )}
              <div className="absolute top-[-12] left-1/2 transform -translate-x-1/2 min-w-0 max-w-36 text-center px-2">
                <span className={`text-sm font-medium whitespace-nowrap ${index <= currentStep ? 'text-primary-600' : 'text-gray-500'}`}>
                  {step}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
};

export default StepBar;