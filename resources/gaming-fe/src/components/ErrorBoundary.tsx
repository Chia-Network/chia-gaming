import React from 'react';

export interface ErrorProps {
  rerender: () => void;
  children: any;
}

export class ErrorBoundary extends React.Component<ErrorProps> {
  state: any;

  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    // Update state so the next render will show the fallback UI.
    return { hasError: error.toString() };
  }

  componentDidCatch(error: any, info: any) {
    // Ok.
  }

  render() {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return (
        <button
          onClick={() => {
            this.state.hasError = false;
            this.props.rerender();
          }}
        >
          Error rendering: {this.state.hasError}
        </button>
      );
    }

    return this.props.children;
  }
}
