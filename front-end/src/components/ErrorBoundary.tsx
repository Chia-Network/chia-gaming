import React from 'react';

export interface ErrorProps {
  rerender: () => void;
  children: React.ReactNode;
}

interface ErrorState {
  hasError: string | false;
}

export class ErrorBoundary extends React.Component<ErrorProps, ErrorState> {
  constructor(props: ErrorProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorState {
    return { hasError: error.toString() };
  }

  componentDidCatch(_error: Error, _info: React.ErrorInfo) {
    // Ok.
  }

  render() {
    if (this.state.hasError) {
      return (
        <button
          onClick={() => {
            this.setState({ hasError: false });
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
