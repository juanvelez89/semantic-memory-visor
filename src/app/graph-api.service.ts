import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { GraphQuery, GraphResponse, HealthResponse, UsersResponse } from './graph.models';

@Injectable({ providedIn: 'root' })
export class GraphApiService {
  constructor(private readonly http: HttpClient) {}

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/health');
  }

  users(): Observable<UsersResponse> {
    return this.http.get<UsersResponse>('/api/users');
  }

  graph(query: GraphQuery): Observable<GraphResponse> {
    let params = new HttpParams()
      .set('tenantId', query.tenantId)
      .set('userId', query.userId)
      .set('status', query.status)
      .set('relationType', query.relationType)
      .set('search', query.search)
      .set('limit', query.limit);

    return this.http.get<GraphResponse>('/api/graph', { params });
  }
}
